import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  AuditActorType,
  OrderStatus,
  PaymentIntentStatus,
  Prisma,
  ReservationStatus,
  WebhookEventOutcome,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  campaignExpiryKey,
  campaignProvisionalKey,
  campaignQuotaKey,
  campaignReadyKey,
  reservationKey,
  stockKey,
} from './flash-sale.keys';
import {
  CONFIRM_RESERVATION_LUA,
  GET_RESERVATION_MIRROR_LUA,
  RELEASE_RESERVATION_LUA,
} from './flash-sale.lua';
import { FlashSaleRedisMirrorService } from './flash-sale-redis-mirror.service';
import { OrderStateMachine } from '../orders/order-state-machine';
import { FlashSaleMetricsService } from './flash-sale.metrics';

const INT_MAX = 2_147_483_647;

export interface VerifiedPaymentSuccessEvent {
  eventId: string;
  type: 'payment.succeeded';
  providerReference: string;
  amount: string;
  currency: string;
  occurredAt?: string;
}

export interface VerifiedPaymentFailureEvent {
  eventId: string;
  type: 'payment.failed';
  providerReference: string;
  amount: string;
  currency: string;
  occurredAt?: string;
}

interface LockedOrder {
  id: string;
  user_id: string;
  status: string;
  correlation_id: string | null;
}

interface LockedReservation {
  id: string;
  campaign_id: string;
  user_id: string;
  order_id: string;
  status: string;
  expires_at: Date;
}

interface LockedPaymentIntent {
  id: string;
  status: string;
  amount: bigint;
  currency: string;
}

interface LockedStock {
  id: string;
  available: number;
  reserved: number;
  sold: number;
  allocated: number;
}

interface LockedQuota {
  id: string;
  active_quantity: number;
  purchased_quantity: number;
}

interface MirrorMutation {
  kind: 'release' | 'confirm';
  targetStatus?: 'EXPIRED' | 'RELEASED';
  campaignId: string;
  userId: string;
  reservationId: string;
  items: Array<{ productId: string; quantity: number }>;
}

function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('Unexpected Redis Lua response');
  return value.map(Number);
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === code;
}

@Injectable()
export class FlashSaleLifecycleService {
  private readonly logger = new Logger(FlashSaleLifecycleService.name);
  private readonly stateMachine = new OrderStateMachine();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mirror: FlashSaleRedisMirrorService,
    private readonly metrics: FlashSaleMetricsService,
  ) {}

  /**
   * Customer cancellation for flash-sale orders. It shares the exact lock order
   * with expiry and payment callbacks, so a concurrent payment cannot both
   * confirm and release the same reservation.
   */
  async cancelFlashSaleOrder(
    orderId: string,
    userId: string,
    reason: string,
  ) {
    const cleanReason = reason.trim().slice(0, 500);
    if (cleanReason.length < 3) {
      throw new ConflictException('A cancellation reason is required');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const orders = await tx.$queryRaw<LockedOrder[]>`
        SELECT "id", "userId" AS "user_id", "status"::text AS "status", "correlation_id" AS "correlation_id"
        FROM "orders"
        WHERE "id" = ${orderId} AND "userId" = ${userId}
        FOR UPDATE
      `;
      const order = orders[0];
      if (!order) throw new NotFoundException('Order not found');

      const reservations = await tx.$queryRaw<LockedReservation[]>`
        SELECT "id", "campaign_id", "user_id", "order_id",
               "status"::text AS "status", "expires_at"
        FROM "flash_sale_reservations"
        WHERE "order_id" = ${orderId}
        FOR UPDATE
      `;
      const reservation = reservations[0];
      if (!reservation) throw new NotFoundException('Flash-sale reservation not found');

      if (
        (order.status === OrderStatus.CANCELLED &&
          reservation.status === ReservationStatus.RELEASED) ||
        (order.status === OrderStatus.EXPIRED &&
          reservation.status === ReservationStatus.EXPIRED)
      ) {
        return { kind: 'already-terminal' as const };
      }

      if (reservation.status !== ReservationStatus.ACTIVE) {
        throw new ConflictException('Reservation is no longer active');
      }

      if (
        order.status !== OrderStatus.PENDING_PAYMENT &&
        order.status !== OrderStatus.CANCELLED &&
        order.status !== OrderStatus.EXPIRED
      ) {
        throw new ConflictException('A paid or processed order cannot be cancelled through this endpoint');
      }

      const clocks = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"
      `;
      const now = clocks[0]?.now;
      if (!now) throw new Error('Could not read PostgreSQL clock');
      const isExpired = reservation.expires_at <= now ||
        order.status === OrderStatus.EXPIRED;
      const targetReservationStatus = isExpired
        ? ReservationStatus.EXPIRED
        : ReservationStatus.RELEASED;
      const targetOrderStatus = isExpired
        ? OrderStatus.EXPIRED
        : OrderStatus.CANCELLED;

      const items = await this.releaseStockInTransaction(tx, reservation);
      await tx.reservation.update({
        where: { id: reservation.id },
        data: { status: targetReservationStatus },
      });

      let changedHistoryId: string | undefined;
      if (order.status === OrderStatus.PENDING_PAYMENT) {
        if (!this.stateMachine.canTransition(
          OrderStatus.PENDING_PAYMENT,
          targetOrderStatus,
        )) {
          throw new ConflictException('Invalid cancellation transition');
        }

        await tx.order.update({
          where: { id: orderId },
          data: { status: targetOrderStatus },
        });
        const history = await tx.orderStatusHistory.create({
          data: {
            orderId,
            fromStatus: OrderStatus.PENDING_PAYMENT,
            toStatus: targetOrderStatus,
            actorId: userId,
            actorType: AuditActorType.USER,
            reason: cleanReason,
          },
          select: { id: true },
        });
        changedHistoryId = history.id;
        await tx.outboxEvent.create({
          data: {
            type: 'ORDER_STATUS_CHANGED',
            aggregateId: orderId,
            payload: {
              orderId,
              historyId: history.id,
              correlationId: order.correlation_id,
              fromStatus: OrderStatus.PENDING_PAYMENT,
              toStatus: targetOrderStatus,
            } as Prisma.InputJsonValue,
          },
        });
      }

      const mirrorMutation: MirrorMutation = {
        kind: 'release',
        targetStatus: targetReservationStatus === ReservationStatus.EXPIRED
          ? 'EXPIRED'
          : 'RELEASED',
        campaignId: reservation.campaign_id,
        userId: reservation.user_id,
        reservationId: reservation.id,
        items,
      };
      await this.writeMirrorOutbox(tx, mirrorMutation);

      return {
        kind: isExpired ? 'expired' as const : 'cancelled' as const,
        historyId: changedHistoryId,
        mirror: mirrorMutation,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 30_000,
    });

    if ('mirror' in result && result.mirror) {
      await this.applyMirrorMutation(result.mirror);
    }
    return { kind: result.kind };
  }

  /**
   * Called by a delayed BullMQ job. Redis TTL is not the authority; Postgres
   * time and the ACTIVE reservation state decide whether expiry is allowed.
   */
  async expireReservation(reservationId: string, correlationId?: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const orderRows = await tx.$queryRaw<LockedOrder[]>`
        SELECT o."id", o."userId" AS "user_id", o."status"::text AS "status", o."correlation_id" AS "correlation_id"
        FROM "orders" o
        JOIN "flash_sale_reservations" r ON r."order_id" = o."id"
        WHERE r."id" = ${reservationId}
        FOR UPDATE OF o
      `;
      const order = orderRows[0];
      if (!order) throw new ConflictException('Refund order not found');

      const reservationRows = await tx.$queryRaw<LockedReservation[]>`
        SELECT "id", "campaign_id", "user_id", "order_id",
               "status"::text AS "status", "expires_at"
        FROM "flash_sale_reservations"
        WHERE "id" = ${reservationId}
        FOR UPDATE
      `;
      const reservation = reservationRows[0];
      if (!reservation || reservation.status !== ReservationStatus.ACTIVE) {
        return { kind: 'skipped' as const };
      }

      const clocks = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"
      `;
      const now = clocks[0]?.now;
      if (!now) throw new Error('Could not read PostgreSQL clock');
      if (reservation.expires_at > now) {
        return {
          kind: 'not-due' as const,
          expiresAt: reservation.expires_at,
        };
      }

      // Legacy/customer cancellation may win before the expiry worker. Release
      // that still-active reservation, but never overwrite a paid order.
      if (
        order.status !== OrderStatus.PENDING_PAYMENT &&
        order.status !== OrderStatus.CANCELLED &&
        order.status !== OrderStatus.EXPIRED
      ) {
        throw new ConflictException(
          `Active reservation ${reservationId} has unexpected order state ${order.status}`,
        );
      }

      const items = await this.releaseStockInTransaction(tx, reservation);
      const targetReservationStatus =
        order.status === OrderStatus.CANCELLED
          ? ReservationStatus.RELEASED
          : ReservationStatus.EXPIRED;

      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: targetReservationStatus },
      });

      let historyId: string | undefined;
      if (order.status === OrderStatus.PENDING_PAYMENT) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.EXPIRED },
        });
        const expiredHistory = await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            fromStatus: OrderStatus.PENDING_PAYMENT,
            toStatus: OrderStatus.EXPIRED,
            actorId: null,
            actorType: AuditActorType.SYSTEM,
            reason: `Flash-sale reservation ${reservationId} expired`,
          },
          select: { id: true },
        });
        historyId = expiredHistory.id;
        await tx.outboxEvent.create({
          data: {
            type: 'ORDER_STATUS_CHANGED',
            aggregateId: order.id,
            payload: {
              orderId: order.id,
              historyId: expiredHistory.id,
              correlationId: order.correlation_id,
              fromStatus: OrderStatus.PENDING_PAYMENT,
              toStatus: OrderStatus.EXPIRED,
            } as Prisma.InputJsonValue,
          },
        });
      }

      const mirrorMutation: MirrorMutation = {
        kind: 'release',
        targetStatus: targetReservationStatus === ReservationStatus.RELEASED
          ? 'RELEASED'
          : 'EXPIRED',
        campaignId: reservation.campaign_id,
        userId: reservation.user_id,
        reservationId,
        items,
      };
      await this.writeMirrorOutbox(tx, mirrorMutation);

      return {
        kind: order.status === OrderStatus.CANCELLED
          ? 'released' as const
          : 'expired' as const,
        mirror: mirrorMutation,
        historyId,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 30_000,
    });

    if ('mirror' in result && result.mirror) {
      await this.applyMirrorMutation(result.mirror);
      this.metrics.recordExpiration(result.kind);
      this.logger.log(JSON.stringify({
        event: 'flash_sale_reservation_expiration',
        correlationId: correlationId ?? reservationId,
        reservationId,
        outcome: result.kind,
      }));
      return { kind: result.kind as 'expired' | 'released' };
    }
    return result;
  }

  /**
   * Recovery sweep: delayed jobs are a trigger, not the only path to expiry.
   * This bounded DB-time scan repairs missed/out-of-service queue work. Multiple
   * instances may select the same IDs; expireReservation serializes idempotently.
   */
  @Interval(15_000)
  async sweepExpiredReservations() {
    let due: Array<{ id: string }>;
    try {
      due = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "flash_sale_reservations"
        WHERE "status" = 'ACTIVE'::flash_sale_reservation_status
          AND "expires_at" <= clock_timestamp()
        ORDER BY "expires_at" ASC
        LIMIT 100
      `;
    } catch (error) {
      this.logger.warn(
        `Flash-sale expiry sweep query failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return;
    }

    for (const reservation of due) {
      try {
        await this.expireReservation(reservation.id);
      } catch (error) {
        this.logger.error(
          `Flash-sale expiry sweep failed for ${reservation.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  }

  /**
   * Invoke only after HMAC verification and strict payload validation.
   * The webhook row, payment/order transition, reservation counters, and audit
   * are committed together. A duplicate eventId cannot apply the transition twice.
   */
  async handleVerifiedPaymentSuccess(
    event: VerifiedPaymentSuccessEvent,
    payloadHash: string,
  ) {
    const payload = JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
    let result: {
      received: true;
      duplicate: boolean;
      outcome: WebhookEventOutcome;
      mirror?: MirrorMutation;
    };
    let correlationId = event.eventId;

    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Lookup is non-locking only to discover related IDs. All stateful
        // locks then follow Order -> Reservation -> PaymentIntent -> stocks -> quota.
        const knownIntent = await tx.paymentIntent.findUnique({
          where: { providerReference: event.providerReference },
          select: { id: true, orderId: true },
        });

        const webhook = await tx.webhookEvent.create({
          data: {
            eventId: event.eventId,
            paymentIntentId: knownIntent?.id ?? null,
            eventType: event.type,
            payloadHash,
            payload,
            outcome: WebhookEventOutcome.RECEIVED,
          },
          select: { id: true },
        });

        const finish = async (
          outcome: WebhookEventOutcome,
          mirror?: MirrorMutation,
        ) => {
          await tx.webhookEvent.update({
            where: { id: webhook.id },
            data: { outcome, processedAt: new Date() },
          });
          return { received: true as const, duplicate: false, outcome, mirror };
        };

        if (!knownIntent) {
          return finish(WebhookEventOutcome.UNKNOWN_PAYMENT);
        }

        const orderRows = await tx.$queryRaw<LockedOrder[]>`
          SELECT "id", "userId" AS "user_id", "status"::text AS "status", "correlation_id" AS "correlation_id"
          FROM "orders"
          WHERE "id" = ${knownIntent.orderId}
          FOR UPDATE
        `;
        const order = orderRows[0];
        if (!order) return finish(WebhookEventOutcome.UNKNOWN_PAYMENT);
        correlationId = order.correlation_id ?? event.eventId;

        const reservationRows = await tx.$queryRaw<LockedReservation[]>`
          SELECT "id", "campaign_id", "user_id", "order_id",
                 "status"::text AS "status", "expires_at"
          FROM "flash_sale_reservations"
          WHERE "order_id" = ${order.id}
          FOR UPDATE
        `;
        const reservation = reservationRows[0];
        if (!reservation) {
          return finish(WebhookEventOutcome.ORDER_NOT_PAYABLE);
        }

        const intentRows = await tx.$queryRaw<LockedPaymentIntent[]>`
          SELECT "id", "status"::text AS "status", "amount", "currency"
          FROM "payment_intents"
          WHERE "id" = ${knownIntent.id}
          FOR UPDATE
        `;
        const intent = intentRows[0];
        if (!intent) return finish(WebhookEventOutcome.UNKNOWN_PAYMENT);

        let amount: bigint;
        try {
          amount = BigInt(event.amount);
        } catch {
          return finish(WebhookEventOutcome.AMOUNT_MISMATCH);
        }
        if (intent.amount !== amount || intent.currency !== event.currency) {
          return finish(WebhookEventOutcome.AMOUNT_MISMATCH);
        }

        if (
          intent.status === PaymentIntentStatus.SUCCEEDED ||
          intent.status === PaymentIntentStatus.REFUND_REQUIRED ||
          reservation.status === ReservationStatus.CONFIRMED
        ) {
          return finish(WebhookEventOutcome.ORDER_ALREADY_PROCESSED);
        }

        const clocks = await tx.$queryRaw<Array<{ now: Date }>>`
          SELECT clock_timestamp() AS "now"
        `;
        const now = clocks[0]?.now;
        if (!now) throw new Error('Could not read PostgreSQL clock');

        const expiredByTime = reservation.status === ReservationStatus.ACTIVE &&
          reservation.expires_at <= now;
        const orderAlreadyCancelled = order.status === OrderStatus.CANCELLED;
        const orderAlreadyExpired = order.status === OrderStatus.EXPIRED;

        if (
          reservation.status === ReservationStatus.ACTIVE &&
          !expiredByTime &&
          order.status === OrderStatus.PENDING_PAYMENT &&
          intent.status === PaymentIntentStatus.PENDING
        ) {
          const items = await this.confirmStockInTransaction(tx, reservation);

          await tx.reservation.update({
            where: { id: reservation.id },
            data: { status: ReservationStatus.CONFIRMED },
          });
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.PAID },
          });
          await tx.paymentIntent.update({
            where: { id: intent.id },
            data: { status: PaymentIntentStatus.SUCCEEDED },
          });
          const paidHistory = await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: OrderStatus.PENDING_PAYMENT,
              toStatus: OrderStatus.PAID,
              actorId: null,
              actorType: AuditActorType.SYSTEM,
              reason: `Payment webhook ${event.eventId}`,
            },
            select: { id: true },
          });
          await tx.outboxEvent.create({
            data: {
              type: 'ORDER_STATUS_CHANGED',
              aggregateId: order.id,
              payload: {
                orderId: order.id,
                historyId: paidHistory.id,
                correlationId: order.correlation_id,
                fromStatus: OrderStatus.PENDING_PAYMENT,
                toStatus: OrderStatus.PAID,
              } as Prisma.InputJsonValue,
            },
          });

          const mirrorMutation: MirrorMutation = {
            kind: 'confirm',
            campaignId: reservation.campaign_id,
            userId: reservation.user_id,
            reservationId: reservation.id,
            items,
          };
          await this.writeMirrorOutbox(tx, mirrorMutation);
          return finish(WebhookEventOutcome.PROCESSED, mirrorMutation);
        }

        // If a worker hasn't run yet but the DB deadline has passed, release
        // the stock in this transaction before queuing the required refund.
        let mirror: MirrorMutation | undefined;
        let effectiveOrderStatus = order.status as OrderStatus;
        if (
          reservation.status === ReservationStatus.ACTIVE &&
          (expiredByTime || orderAlreadyCancelled || orderAlreadyExpired ||
            intent.status === PaymentIntentStatus.FAILED)
        ) {
          const releasedItems = await this.releaseStockInTransaction(tx, reservation);
          const releasedStatus = expiredByTime || orderAlreadyExpired
            ? ReservationStatus.EXPIRED
            : ReservationStatus.RELEASED;
          await tx.reservation.update({
            where: { id: reservation.id },
            data: { status: releasedStatus },
          });
          if (order.status === OrderStatus.PENDING_PAYMENT) {
            const terminalStatus = expiredByTime || orderAlreadyExpired
              ? OrderStatus.EXPIRED
              : OrderStatus.CANCELLED;
            if (!this.stateMachine.canTransition(
              OrderStatus.PENDING_PAYMENT,
              terminalStatus,
            )) {
              throw new ConflictException(
                `Invalid terminal transition to ${terminalStatus}`,
              );
            }
            await tx.order.update({
              where: { id: order.id },
              data: { status: terminalStatus },
            });
            const terminalHistory = await tx.orderStatusHistory.create({
              data: {
                orderId: order.id,
                fromStatus: OrderStatus.PENDING_PAYMENT,
                toStatus: terminalStatus,
                actorId: null,
                actorType: AuditActorType.SYSTEM,
                reason: expiredByTime
                  ? `Reservation ${reservation.id} expired before payment was processed`
                  : `Payment was no longer payable for reservation ${reservation.id}`,
              },
              select: { id: true },
            });
            await tx.outboxEvent.create({
              data: {
                type: 'ORDER_STATUS_CHANGED',
                aggregateId: order.id,
                payload: {
                  orderId: order.id,
                  historyId: terminalHistory.id,
                  correlationId: order.correlation_id,
                  fromStatus: OrderStatus.PENDING_PAYMENT,
                  toStatus: terminalStatus,
                } as Prisma.InputJsonValue,
              },
            });
            effectiveOrderStatus = terminalStatus;
          }
          mirror = {
            kind: 'release',
            targetStatus: releasedStatus === ReservationStatus.EXPIRED ? 'EXPIRED' : 'RELEASED',
            campaignId: reservation.campaign_id,
            userId: reservation.user_id,
            reservationId: reservation.id,
            items: releasedItems,
          };
          await this.writeMirrorOutbox(tx, mirror);
        }

        // Defensive repair: a terminal reservation with a still-pending order
        // is inconsistent data. Close the order through a legal transition
        // before requesting the refund, rather than losing the late success.
        if (
          effectiveOrderStatus === OrderStatus.PENDING_PAYMENT &&
          (reservation.status === ReservationStatus.EXPIRED ||
            reservation.status === ReservationStatus.RELEASED)
        ) {
          const terminalStatus = reservation.status === ReservationStatus.EXPIRED
            ? OrderStatus.EXPIRED
            : OrderStatus.CANCELLED;
          if (!this.stateMachine.canTransition(
            OrderStatus.PENDING_PAYMENT,
            terminalStatus,
          )) {
            throw new ConflictException(
              `Invalid repair transition to ${terminalStatus}`,
            );
          }
          await tx.order.update({
            where: { id: order.id },
            data: { status: terminalStatus },
          });
          const terminalHistory = await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: OrderStatus.PENDING_PAYMENT,
              toStatus: terminalStatus,
              actorId: null,
              actorType: AuditActorType.SYSTEM,
              reason: `Reconciled terminal reservation ${reservation.id} after late payment`,
            },
            select: { id: true },
          });
          await tx.outboxEvent.create({
            data: {
              type: 'ORDER_STATUS_CHANGED',
              aggregateId: order.id,
              payload: {
                orderId: order.id,
                historyId: terminalHistory.id,
                correlationId: order.correlation_id,
                fromStatus: OrderStatus.PENDING_PAYMENT,
                toStatus: terminalStatus,
              } as Prisma.InputJsonValue,
            },
          });
          effectiveOrderStatus = terminalStatus;
        }

        if (
          effectiveOrderStatus === OrderStatus.EXPIRED ||
          effectiveOrderStatus === OrderStatus.CANCELLED ||
          reservation.status === ReservationStatus.EXPIRED ||
          reservation.status === ReservationStatus.RELEASED
        ) {
          if (effectiveOrderStatus !== OrderStatus.REFUND_PENDING) {
            if (!this.stateMachine.canTransition(
              effectiveOrderStatus,
              OrderStatus.REFUND_PENDING,
            )) {
              return finish(WebhookEventOutcome.ORDER_NOT_PAYABLE, mirror);
            }
            await tx.order.update({
              where: { id: order.id },
              data: { status: OrderStatus.REFUND_PENDING },
            });
            const refundHistory = await tx.orderStatusHistory.create({
              data: {
                orderId: order.id,
                fromStatus: effectiveOrderStatus,
                toStatus: OrderStatus.REFUND_PENDING,
                actorId: null,
                actorType: AuditActorType.SYSTEM,
                reason: `Late successful payment ${event.eventId}; refund required`,
              },
              select: { id: true },
            });
            await tx.outboxEvent.create({
              data: {
                type: 'ORDER_STATUS_CHANGED',
                aggregateId: order.id,
                payload: {
                  orderId: order.id,
                  historyId: refundHistory.id,
                  correlationId: order.correlation_id,
                  fromStatus: effectiveOrderStatus,
                  toStatus: OrderStatus.REFUND_PENDING,
                } as Prisma.InputJsonValue,
              },
            });
          }
          await tx.paymentIntent.update({
            where: { id: intent.id },
            data: { status: PaymentIntentStatus.REFUND_REQUIRED },
          });
          await tx.outboxEvent.create({
            data: {
              type: 'PAYMENT_REFUND_REQUESTED',
              aggregateId: intent.id,
              payload: {
                paymentIntentId: intent.id,
                orderId: order.id,
                correlationId: order.correlation_id,
                eventId: event.eventId,
                reason: 'Payment succeeded after reservation expiry/cancellation',
              } as Prisma.InputJsonValue,
            },
          });
          return finish(
            WebhookEventOutcome.ORDER_CANCELLED_REFUND_REQUIRED,
            mirror,
          );
        }

        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: PaymentIntentStatus.REFUND_REQUIRED },
        });
        await tx.outboxEvent.create({
          data: {
            type: 'PAYMENT_REFUND_REQUESTED',
            aggregateId: intent.id,
            payload: {
              paymentIntentId: intent.id,
              orderId: order.id,
              correlationId: order.correlation_id,
              eventId: event.eventId,
              reason: 'Order is not payable',
            } as Prisma.InputJsonValue,
          },
        });
        return finish(WebhookEventOutcome.ORDER_NOT_PAYABLE, mirror);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error;

      const existing = await this.prisma.webhookEvent.findUnique({
        where: { eventId: event.eventId },
        select: { payloadHash: true, outcome: true },
      });
      if (!existing) throw error;
      if (existing.payloadHash !== payloadHash) {
        throw new ConflictException('Webhook event ID reused with different payload');
      }
      this.metrics.recordWebhook(event.type, 'duplicate');
      return {
        received: true as const,
        duplicate: true,
        outcome: existing.outcome,
      };
    }

    if (result.mirror) {
      await this.applyMirrorMutation(result.mirror);
    }
    this.metrics.recordWebhook(event.type, result.outcome);
    this.logger.log(JSON.stringify({
      event: 'flash_sale_payment_webhook_processed',
      correlationId,
      eventId: event.eventId,
      outcome: result.outcome,
    }));

    return {
      received: result.received,
      duplicate: result.duplicate,
      outcome: result.outcome,
    };
  }


  /**
   * Complete the mock refund after the refund queue has accepted the job.
   * Real integrations must call this only after the provider confirms the
   * refund, using a provider-side idempotency key.
   */
  async completeMockRefund(paymentIntentId: string) {
    const reference = await this.prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      select: { orderId: true },
    });
    if (!reference) throw new ConflictException('Refund payment intent not found');

    return this.prisma.$transaction(async (tx) => {
      const orders = await tx.$queryRaw<Array<{ id: string; status: string; correlation_id: string | null }>>`
        SELECT "id", "status"::text AS "status", "correlation_id" AS "correlation_id"
        FROM "orders"
        WHERE "id" = ${reference.orderId}
        FOR UPDATE
      `;
      const order = orders[0];
      if (!order) return { kind: 'skipped' as const };

      const reservations = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status"::text AS "status"
        FROM "flash_sale_reservations"
        WHERE "order_id" = ${order.id}
        FOR UPDATE
      `;
      const reservation = reservations[0];

      const intents = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status"::text AS "status"
        FROM "payment_intents"
        WHERE "id" = ${paymentIntentId}
        FOR UPDATE
      `;
      const intent = intents[0];
      if (!intent) throw new ConflictException('Refund payment intent disappeared');

      if (
        order.status === OrderStatus.REFUNDED &&
        intent.status === PaymentIntentStatus.REFUNDED
      ) {
        return { kind: 'already-refunded' as const };
      }

      if (
        order.status !== OrderStatus.REFUND_PENDING ||
        intent.status !== PaymentIntentStatus.REFUND_REQUIRED
      ) {
        throw new ConflictException(
          `Refund is not ready: order=${order.status}, payment=${intent.status}`,
        );
      }

      // This worker currently simulates late-payment refunds, for which the
      // reservation must already be released/expired. Never silently mark a
      // paid, still-confirmed reservation refunded without stock policy.
      if (
        !reservation ||
        (reservation.status !== ReservationStatus.EXPIRED &&
          reservation.status !== ReservationStatus.RELEASED)
      ) {
        throw new ConflictException(
          'Refund is not safe to complete while the reservation is not released',
        );
      }

      if (!this.stateMachine.canTransition(
        OrderStatus.REFUND_PENDING,
        OrderStatus.REFUNDED,
      )) {
        throw new ConflictException('Invalid REFUND_PENDING -> REFUNDED transition');
      }

      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.REFUNDED },
      });
      await tx.paymentIntent.update({
        where: { id: paymentIntentId },
        data: { status: PaymentIntentStatus.REFUNDED },
      });

      const history = await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: OrderStatus.REFUND_PENDING,
          toStatus: OrderStatus.REFUNDED,
          actorId: null,
          actorType: AuditActorType.SYSTEM,
          reason: `Mock refund completed for payment intent ${paymentIntentId}`,
        },
        select: { id: true },
      });

      await tx.outboxEvent.create({
        data: {
          type: 'ORDER_STATUS_CHANGED',
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            historyId: history.id,
            correlationId: order.correlation_id,
            fromStatus: OrderStatus.REFUND_PENDING,
            toStatus: OrderStatus.REFUNDED,
          } as Prisma.InputJsonValue,
        },
      });

      return { kind: 'refunded' as const };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 30_000,
    });
  }

  /**
   * A verified payment failure releases an active reservation once. If the
   * success callback arrives later, the success handler sees the terminal
   * reservation/order and records REFUND_PENDING rather than re-reserving stock.
   */
  async handleVerifiedPaymentFailure(
    event: VerifiedPaymentFailureEvent,
    payloadHash: string,
  ) {
    const payload = JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
    let result: {
      received: true;
      duplicate: boolean;
      outcome: WebhookEventOutcome;
      mirror?: MirrorMutation;
    };
    let correlationId = event.eventId;

    try {
      result = await this.prisma.$transaction(async (tx) => {
        const knownIntent = await tx.paymentIntent.findUnique({
          where: { providerReference: event.providerReference },
          select: { id: true, orderId: true },
        });

        const webhook = await tx.webhookEvent.create({
          data: {
            eventId: event.eventId,
            paymentIntentId: knownIntent?.id ?? null,
            eventType: event.type,
            payloadHash,
            payload,
            outcome: WebhookEventOutcome.RECEIVED,
          },
          select: { id: true },
        });

        const finish = async (
          outcome: WebhookEventOutcome,
          mirror?: MirrorMutation,
        ) => {
          await tx.webhookEvent.update({
            where: { id: webhook.id },
            data: { outcome, processedAt: new Date() },
          });
          return { received: true as const, duplicate: false, outcome, mirror };
        };

        if (!knownIntent) return finish(WebhookEventOutcome.UNKNOWN_PAYMENT);

        const orderRows = await tx.$queryRaw<LockedOrder[]>`
          SELECT "id", "userId" AS "user_id", "status"::text AS "status", "correlation_id" AS "correlation_id"
          FROM "orders"
          WHERE "id" = ${knownIntent.orderId}
          FOR UPDATE
        `;
        const order = orderRows[0];
        if (!order) return finish(WebhookEventOutcome.UNKNOWN_PAYMENT);
        correlationId = order.correlation_id ?? event.eventId;

        const reservationRows = await tx.$queryRaw<LockedReservation[]>`
          SELECT "id", "campaign_id", "user_id", "order_id",
                 "status"::text AS "status", "expires_at"
          FROM "flash_sale_reservations"
          WHERE "order_id" = ${order.id}
          FOR UPDATE
        `;
        const reservation = reservationRows[0];
        if (!reservation) return finish(WebhookEventOutcome.ORDER_NOT_PAYABLE);

        const intentRows = await tx.$queryRaw<LockedPaymentIntent[]>`
          SELECT "id", "status"::text AS "status", "amount", "currency"
          FROM "payment_intents"
          WHERE "id" = ${knownIntent.id}
          FOR UPDATE
        `;
        const intent = intentRows[0];
        if (!intent) return finish(WebhookEventOutcome.UNKNOWN_PAYMENT);

        let amount: bigint;
        try {
          amount = BigInt(event.amount);
        } catch {
          return finish(WebhookEventOutcome.AMOUNT_MISMATCH);
        }
        if (intent.amount !== amount || intent.currency !== event.currency) {
          return finish(WebhookEventOutcome.AMOUNT_MISMATCH);
        }

        if (
          intent.status === PaymentIntentStatus.SUCCEEDED ||
          intent.status === PaymentIntentStatus.REFUND_REQUIRED ||
          intent.status === PaymentIntentStatus.FAILED ||
          reservation.status === ReservationStatus.CONFIRMED
        ) {
          return finish(WebhookEventOutcome.ORDER_ALREADY_PROCESSED);
        }

        if (reservation.status !== ReservationStatus.ACTIVE) {
          await tx.paymentIntent.update({
            where: { id: intent.id },
            data: { status: PaymentIntentStatus.FAILED },
          });
          return finish(WebhookEventOutcome.ORDER_ALREADY_PROCESSED);
        }

        const orderIsPending = order.status === OrderStatus.PENDING_PAYMENT;
        const orderIsAlreadyTerminal =
          order.status === OrderStatus.CANCELLED ||
          order.status === OrderStatus.EXPIRED;

        // If another cancellation path changed the order but did not release
        // its reservation, a verified failure callback repairs that leak.
        if (!orderIsPending && !orderIsAlreadyTerminal) {
          return finish(WebhookEventOutcome.ORDER_NOT_PAYABLE);
        }

        const clocks = await tx.$queryRaw<Array<{ now: Date }>>`
          SELECT clock_timestamp() AS "now"
        `;
        const now = clocks[0]?.now;
        if (!now) throw new Error('Could not read PostgreSQL clock');
        const expired = reservation.expires_at <= now ||
          order.status === OrderStatus.EXPIRED;
        const items = await this.releaseStockInTransaction(tx, reservation);
        const newReservationStatus = expired
          ? ReservationStatus.EXPIRED
          : ReservationStatus.RELEASED;
        const newOrderStatus = expired
          ? OrderStatus.EXPIRED
          : OrderStatus.CANCELLED;

        if (orderIsPending && !this.stateMachine.canTransition(
          OrderStatus.PENDING_PAYMENT,
          newOrderStatus,
        )) {
          throw new ConflictException(
            `Invalid payment-failure transition to ${newOrderStatus}`,
          );
        }

        await tx.reservation.update({
          where: { id: reservation.id },
          data: { status: newReservationStatus },
        });
        if (orderIsPending) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: newOrderStatus },
          });
        }
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: PaymentIntentStatus.FAILED },
        });

        if (orderIsPending) {
          const history = await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: OrderStatus.PENDING_PAYMENT,
              toStatus: newOrderStatus,
              actorId: null,
              actorType: AuditActorType.SYSTEM,
              reason: `Payment failure webhook ${event.eventId}; reservation released`,
            },
            select: { id: true },
          });
          await tx.outboxEvent.create({
            data: {
              type: 'ORDER_STATUS_CHANGED',
              aggregateId: order.id,
              payload: {
                orderId: order.id,
                historyId: history.id,
                correlationId: order.correlation_id,
                fromStatus: OrderStatus.PENDING_PAYMENT,
                toStatus: newOrderStatus,
              } as Prisma.InputJsonValue,
            },
          });
        }

        const mirrorMutation: MirrorMutation = {
          kind: 'release',
          targetStatus: newReservationStatus === ReservationStatus.EXPIRED
            ? 'EXPIRED'
            : 'RELEASED',
          campaignId: reservation.campaign_id,
          userId: reservation.user_id,
          reservationId: reservation.id,
          items,
        };
        await this.writeMirrorOutbox(tx, mirrorMutation);
        return finish(WebhookEventOutcome.PROCESSED, mirrorMutation);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error;

      const existing = await this.prisma.webhookEvent.findUnique({
        where: { eventId: event.eventId },
        select: { payloadHash: true, outcome: true },
      });
      if (!existing) throw error;
      if (existing.payloadHash !== payloadHash) {
        throw new ConflictException('Webhook event ID reused with different payload');
      }
      this.metrics.recordWebhook(event.type, 'duplicate');
      return {
        received: true as const,
        duplicate: true,
        outcome: existing.outcome,
      };
    }

    if (result.mirror) await this.applyMirrorMutation(result.mirror);
    this.metrics.recordWebhook(event.type, result.outcome);
    this.logger.log(JSON.stringify({
      event: 'flash_sale_payment_webhook_processed',
      correlationId,
      eventId: event.eventId,
      outcome: result.outcome,
    }));
    return {
      received: result.received,
      duplicate: result.duplicate,
      outcome: result.outcome,
    };
  }

  /** Called by the transactional outbox dispatcher. Throws on mirror failure so the
   * outbox event remains retryable. Lua mutation scripts are idempotent. */
  async applyMirrorMutationFromOutbox(value: Record<string, unknown>) {
    const kind = value.kind;
    const targetStatus = value.targetStatus;
    const campaignId = value.campaignId;
    const userId = value.userId;
    const reservationId = value.reservationId;
    const rawItems = value.items;

    if (
      (kind !== 'confirm' && kind !== 'release') ||
      typeof campaignId !== 'string' ||
      typeof userId !== 'string' ||
      typeof reservationId !== 'string' ||
      !Array.isArray(rawItems) ||
      (kind === 'release' && targetStatus !== 'EXPIRED' && targetStatus !== 'RELEASED')
    ) {
      throw new Error('Invalid flash-sale mirror outbox payload');
    }

    const items = rawItems.map((entry) => {
      if (
        typeof entry !== 'object' || entry === null ||
        typeof (entry as Record<string, unknown>).productId !== 'string' ||
        !Number.isSafeInteger((entry as Record<string, unknown>).quantity) ||
        Number((entry as Record<string, unknown>).quantity) < 1
      ) {
        throw new Error('Invalid flash-sale mirror outbox item');
      }
      return {
        productId: String((entry as Record<string, unknown>).productId),
        quantity: Number((entry as Record<string, unknown>).quantity),
      };
    }).sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);

    const mutation: MirrorMutation = {
      kind,
      ...(kind === 'release' ? { targetStatus: targetStatus as 'EXPIRED' | 'RELEASED' } : {}),
      campaignId,
      userId,
      reservationId,
      items,
    };

    // A maintenance rebuild reconstructs terminal stock/quota counters from
    // PostgreSQL but does not need hashes for already-terminal reservations.
    // If the campaign gate is closed and this terminal hash is absent, the
    // mutation is already represented by the DB snapshot; openCampaignWrites
    // verifies every mirrored counter and active reservation before reopening.
    const dbReservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { campaignId: true, userId: true, status: true },
    });
    if (!dbReservation || dbReservation.campaignId !== campaignId || dbReservation.userId !== userId) {
      throw new Error(`Flash-sale reservation ${reservationId} is missing or mismatched in PostgreSQL`);
    }
    const expectedDbStatus = kind === 'confirm'
      ? ReservationStatus.CONFIRMED
      : targetStatus === 'EXPIRED'
        ? ReservationStatus.EXPIRED
        : ReservationStatus.RELEASED;
    if (dbReservation.status !== expectedDbStatus) {
      throw new Error(
        `Mirror outbox event expected ${expectedDbStatus}, PostgreSQL has ${dbReservation.status}`,
      );
    }

    const mirrorRaw = await this.redis.evalScript(
      GET_RESERVATION_MIRROR_LUA,
      [reservationKey(campaignId, reservationId)],
      [],
    );
    if (typeof mirrorRaw !== 'string') {
      throw new Error(`Could not inspect Redis reservation ${reservationId}`);
    }
    const currentMirror = JSON.parse(mirrorRaw) as { status?: string | null };
    if (!currentMirror.status) {
      const gate = await this.redis.get(campaignReadyKey(campaignId));
      if (gate !== '1') {
        return { applied: true, alreadyCapturedByClosedGateReconciliation: true };
      }
      await this.mirror.closeWriteGate(
        campaignId,
        `terminal reservation mirror ${reservationId} is missing while write gate is open`,
      );
      throw new Error(`Missing terminal Redis reservation mirror ${reservationId}; rebuild required`);
    }

    const applied = await this.applyMirrorMutation(mutation);
    if (!applied) {
      throw new Error(`Could not apply flash-sale mirror mutation for reservation ${reservationId}`);
    }
    return { applied: true };
  }

  private async writeMirrorOutbox(
    tx: Prisma.TransactionClient,
    mutation: MirrorMutation,
  ) {
    await tx.outboxEvent.create({
      data: {
        type: mutation.kind === 'confirm'
          ? 'FLASH_SALE_MIRROR_CONFIRM'
          : 'FLASH_SALE_MIRROR_RELEASE',
        aggregateId: mutation.reservationId,
        payload: {
          kind: mutation.kind,
          ...(mutation.targetStatus ? { targetStatus: mutation.targetStatus } : {}),
          campaignId: mutation.campaignId,
          userId: mutation.userId,
          reservationId: mutation.reservationId,
          items: mutation.items,
        } as Prisma.InputJsonValue,
      },
    });
  }

  private async releaseStockInTransaction(
    tx: Prisma.TransactionClient,
    reservation: LockedReservation,
  ) {
    const items = await tx.reservationItem.findMany({
      where: { reservationId: reservation.id },
      select: { productId: true, quantity: true },
      orderBy: { productId: 'asc' },
    });
    const sorted = [...items].sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
    const total = sorted.reduce((sum, item) => sum + item.quantity, 0);

    for (const item of sorted) {
      const rows = await tx.$queryRaw<LockedStock[]>`
        SELECT "id", "available", "reserved", "sold", "allocated"
        FROM "flash_sale_stocks"
        WHERE "campaign_id" = ${reservation.campaign_id}
          AND "product_id" = ${item.productId}
        FOR UPDATE
      `;
      const stock = rows[0];
      if (!stock || stock.reserved < item.quantity || stock.available + item.quantity > INT_MAX) {
        throw new ConflictException('Flash-sale stock invariant failed while releasing reservation');
      }
      const changed = await tx.flashSaleStock.updateMany({
        where: {
          campaignId: reservation.campaign_id,
          productId: item.productId,
          reserved: { gte: item.quantity },
        },
        data: {
          reserved: { decrement: item.quantity },
          available: { increment: item.quantity },
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new ConflictException('Stock release lost its guard');
    }

    const quotaRows = await tx.$queryRaw<LockedQuota[]>`
      SELECT "id", "active_quantity", "purchased_quantity"
      FROM "flash_sale_user_quotas"
      WHERE "campaign_id" = ${reservation.campaign_id}
        AND "user_id" = ${reservation.user_id}
      FOR UPDATE
    `;
    const quota = quotaRows[0];
    if (!quota || quota.active_quantity < total) {
      throw new ConflictException('User quota invariant failed while releasing reservation');
    }
    await tx.flashSaleUserQuota.update({
      where: {
        campaignId_userId: {
          campaignId: reservation.campaign_id,
          userId: reservation.user_id,
        },
      },
      data: {
        activeQuantity: { decrement: total },
        version: { increment: 1 },
      },
    });

    return sorted;
  }

  private async confirmStockInTransaction(
    tx: Prisma.TransactionClient,
    reservation: LockedReservation,
  ) {
    const items = await tx.reservationItem.findMany({
      where: { reservationId: reservation.id },
      select: { productId: true, quantity: true },
      orderBy: { productId: 'asc' },
    });
    const sorted = [...items].sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
    const total = sorted.reduce((sum, item) => sum + item.quantity, 0);

    for (const item of sorted) {
      const rows = await tx.$queryRaw<LockedStock[]>`
        SELECT "id", "available", "reserved", "sold", "allocated"
        FROM "flash_sale_stocks"
        WHERE "campaign_id" = ${reservation.campaign_id}
          AND "product_id" = ${item.productId}
        FOR UPDATE
      `;
      const stock = rows[0];
      if (!stock || stock.reserved < item.quantity || stock.sold + item.quantity > stock.allocated) {
        throw new ConflictException('Flash-sale stock invariant failed while confirming reservation');
      }
      const changed = await tx.flashSaleStock.updateMany({
        where: {
          campaignId: reservation.campaign_id,
          productId: item.productId,
          reserved: { gte: item.quantity },
        },
        data: {
          reserved: { decrement: item.quantity },
          sold: { increment: item.quantity },
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new ConflictException('Stock confirmation lost its guard');
    }

    const quotaRows = await tx.$queryRaw<LockedQuota[]>`
      SELECT "id", "active_quantity", "purchased_quantity"
      FROM "flash_sale_user_quotas"
      WHERE "campaign_id" = ${reservation.campaign_id}
        AND "user_id" = ${reservation.user_id}
      FOR UPDATE
    `;
    const quota = quotaRows[0];
    if (!quota || quota.active_quantity < total) {
      throw new ConflictException('User quota invariant failed while confirming reservation');
    }
    await tx.flashSaleUserQuota.update({
      where: {
        campaignId_userId: {
          campaignId: reservation.campaign_id,
          userId: reservation.user_id,
        },
      },
      data: {
        activeQuantity: { decrement: total },
        purchasedQuantity: { increment: total },
        version: { increment: 1 },
      },
    });

    return sorted;
  }

  private async applyMirrorMutation(mutation: MirrorMutation): Promise<boolean> {
    const resKey = reservationKey(mutation.campaignId, mutation.reservationId);
    const expiryKey = campaignExpiryKey(mutation.campaignId);
    const provisionalKey = campaignProvisionalKey(mutation.campaignId);
    const quotaKey = campaignQuotaKey(mutation.campaignId, mutation.userId);
    const stockKeys = mutation.items.map((item) => stockKey(mutation.campaignId, item.productId));

    try {
      const result = mutation.kind === 'confirm'
        ? numbers(await this.redis.evalScript(
            CONFIRM_RESERVATION_LUA,
            [resKey, provisionalKey, expiryKey, quotaKey, ...stockKeys],
            [mutation.reservationId],
          ))
        : numbers(await this.redis.evalScript(
            RELEASE_RESERVATION_LUA,
            [resKey, provisionalKey, expiryKey, quotaKey, ...stockKeys],
            [
              mutation.reservationId,
              'ACTIVE',
              mutation.targetStatus ?? 'EXPIRED',
            ],
          ));

      if (result[0] !== 1) {
        this.metrics.recordMirrorFailure(mutation.kind);
        await this.mirror.closeWriteGate(
          mutation.campaignId,
          `Redis mirror ${mutation.kind} returned ${result[0]}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.metrics.recordMirrorFailure(mutation.kind);
      this.logger.error(
        `Redis mirror ${mutation.kind} failed for reservation ${mutation.reservationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      try {
        await this.mirror.closeWriteGate(
          mutation.campaignId,
          `Redis mirror ${mutation.kind} failed after DB commit`,
        );
      } catch {
        // Redis is down; all new reservations fail at the Redis admission call.
      }
      return false;
    }
  }
}
