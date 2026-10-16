import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  AuditActorType,
  OrderStatus,
  PaymentIntentStatus,
  Prisma,
  WebhookEventOutcome,
} from '../generated/prisma/client';
import { OrderQueuesService } from '../orders/order-queues.service';
import { OrderStateMachine } from '../orders/order-state-machine';
import { PrismaService } from '../prisma/prisma.service';
import { FlashSaleLifecycleService } from '../flash-sale/flash-sale-lifecycle.service';
import type {
  VerifiedPaymentFailureEvent,
  VerifiedPaymentSuccessEvent,
} from '../flash-sale/flash-sale-lifecycle.service';

interface PaymentEvent {
  eventId: string;
  type: 'payment.succeeded' | 'payment.failed';
  providerReference: string;
  amount: string;
  currency: string;
  occurredAt?: string;
}

type LockedOrder = { id: string; status: OrderStatus };
type LockedPayment = {
  id: string;
  status: PaymentIntentStatus;
  amount: bigint;
  currency: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

@Injectable()
export class PaymentWebhookService {
  private readonly secret: string;
  private readonly stateMachine = new OrderStateMachine();
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    private readonly orderQueues: OrderQueuesService,
    private readonly flashSaleLifecycle: FlashSaleLifecycleService,
  ) {
    this.secret = config.getOrThrow<string>('PAYMENT_WEBHOOK_SECRET');
    if (Buffer.byteLength(this.secret, 'utf8') < 32) {
      throw new Error('PAYMENT_WEBHOOK_SECRET must be at least 32 bytes');
    }
  }

  async handleWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!this.verifySignature(rawBody, signature)) {
      throw new UnauthorizedException('Invalid payment webhook signature');
    }
    const event = this.parseEvent(rawBody);
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');

    try {
      const paymentIntent = await this.prisma.paymentIntent.findUnique({
        where: { providerReference: event.providerReference },
        select: { order: { select: { flashSaleReservation: { select: { id: true } } } } },
      });
      if (paymentIntent?.order.flashSaleReservation) {
        const result = event.type === 'payment.succeeded'
          ? await this.flashSaleLifecycle.handleVerifiedPaymentSuccess(
              event as VerifiedPaymentSuccessEvent, payloadHash,
            )
          : await this.flashSaleLifecycle.handleVerifiedPaymentFailure(
              event as VerifiedPaymentFailureEvent, payloadHash,
            );
        return result;
      }
      if (event.type !== 'payment.succeeded') {
        throw new BadRequestException('Payment failure events require a flash-sale order');
      }
      const result = await this.processVerifiedEvent(event, payloadHash, rawBody);
      if (result.notificationHistoryId) {
        try {
          await this.orderQueues.notifyStatusChange(
            result.notificationHistoryId,
          );
        } catch (error) {
          this.logger.error(
            `Could not enqueue payment notification: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }
      const { notificationHistoryId: _notificationHistoryId, ...response } =
        result;
      return response;
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error;
      const existing = await this.prisma.webhookEvent.findUnique({
        where: { eventId: event.eventId },
        select: { payloadHash: true, outcome: true },
      });
      if (!existing) throw error;
      if (existing.payloadHash !== payloadHash) {
        throw new ConflictException(
          'Webhook event ID was reused with different content',
        );
      }
      return { received: true, duplicate: true, outcome: existing.outcome };
    }
  }

  private verifySignature(
    rawBody: Buffer,
    signature: string | undefined,
  ): boolean {
    if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
    const provided = Buffer.from(signature.slice(7), 'hex');
    const expected = createHmac('sha256', this.secret).update(rawBody).digest();
    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  }

  private parseEvent(rawBody: Buffer): PaymentEvent {
    let value: unknown;
    try {
      value = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid webhook JSON');
    }
    if (
      !isRecord(value) ||
      typeof value.eventId !== 'string' ||
      value.eventId.length < 1 ||
      value.eventId.length > 200 ||
      (value.type !== 'payment.succeeded' && value.type !== 'payment.failed') ||
      typeof value.providerReference !== 'string' ||
      value.providerReference.length < 1 ||
      value.providerReference.length > 200 ||
      typeof value.amount !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(value.amount) ||
      typeof value.currency !== 'string' ||
      value.currency.length !== 3 ||
      (value.occurredAt !== undefined && typeof value.occurredAt !== 'string')
    ) {
      throw new BadRequestException('Invalid payment webhook payload');
    }
    return value as unknown as PaymentEvent;
  }

  private async processVerifiedEvent(
    event: PaymentEvent,
    payloadHash: string,
    rawBody: Buffer,
  ) {
    const payload = JSON.parse(
      rawBody.toString('utf8'),
    ) as Prisma.InputJsonValue;
    return this.prisma.$transaction(async (tx) => {
      const knownIntent = await tx.paymentIntent.findUnique({
        where: { providerReference: event.providerReference },
        select: { id: true, orderId: true },
      });
      const webhookEvent = await tx.webhookEvent.create({
        data: {
          eventId: event.eventId,
          paymentIntentId: knownIntent?.id ?? null,
          eventType: event.type,
          payloadHash,
          payload,
          outcome: WebhookEventOutcome.RECEIVED,
        },
      });

      const finish = async (
        outcome: WebhookEventOutcome,
        notificationHistoryId?: string,
      ) => {
        await tx.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { outcome, processedAt: new Date() },
        });
        return {
          received: true,
          duplicate: false,
          outcome,
          notificationHistoryId,
        };
      };

      if (!knownIntent) return finish(WebhookEventOutcome.UNKNOWN_PAYMENT);
      const amount = BigInt(event.amount);
      const lockedOrders = await tx.$queryRaw<LockedOrder[]>`
        SELECT "id", "status" FROM "orders" WHERE "id" = ${knownIntent.orderId} FOR UPDATE
      `;
      const order = lockedOrders[0];
      if (!order) return finish(WebhookEventOutcome.UNKNOWN_PAYMENT);

      const lockedPayments = await tx.$queryRaw<LockedPayment[]>`
        SELECT "id", "status", "amount", "currency"
        FROM "payment_intents" WHERE "id" = ${knownIntent.id} FOR UPDATE
      `;
      const payment = lockedPayments[0];
      if (!payment) return finish(WebhookEventOutcome.UNKNOWN_PAYMENT);

      if (payment.amount !== amount || payment.currency !== event.currency) {
        return finish(WebhookEventOutcome.AMOUNT_MISMATCH);
      }
      if (payment.status !== PaymentIntentStatus.PENDING) {
        return finish(
          payment.status === PaymentIntentStatus.REFUND_REQUIRED
            ? WebhookEventOutcome.ORDER_CANCELLED_REFUND_REQUIRED
            : WebhookEventOutcome.ORDER_ALREADY_PROCESSED,
        );
      }
      if (order.status === OrderStatus.CANCELLED) {
        await tx.paymentIntent.update({
          where: { id: payment.id },
          data: { status: PaymentIntentStatus.REFUND_REQUIRED },
        });
        return finish(WebhookEventOutcome.ORDER_CANCELLED_REFUND_REQUIRED);
      }
      if (order.status !== OrderStatus.PENDING_PAYMENT) {
        await tx.paymentIntent.update({
          where: { id: payment.id },
          data: { status: PaymentIntentStatus.REFUND_REQUIRED },
        });
        return finish(WebhookEventOutcome.ORDER_NOT_PAYABLE);
      }
      if (
        !this.stateMachine.canTransition(
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.PAID,
        )
      ) {
        throw new ConflictException('Payment transition is not allowed');
      }

      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.PAID },
      });
      await tx.paymentIntent.update({
        where: { id: payment.id },
        data: { status: PaymentIntentStatus.SUCCEEDED },
      });
      const history = await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: OrderStatus.PENDING_PAYMENT,
          toStatus: OrderStatus.PAID,
          actorId: null,
          actorType: AuditActorType.SYSTEM,
          reason: `Payment webhook ${event.eventId}`,
        },
      });
      return finish(WebhookEventOutcome.PROCESSED, history.id);
    });
  }
}
