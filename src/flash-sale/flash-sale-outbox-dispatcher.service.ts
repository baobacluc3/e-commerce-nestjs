import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { Prisma } from '../generated/prisma/client';
import { OrderQueuesService } from '../orders/order-queues.service';
import { PrismaService as AppPrismaService } from '../prisma/prisma.service';
import { FlashSaleLifecycleService } from './flash-sale-lifecycle.service';
import {
  FLASH_SALE_EXPIRATION_QUEUE,
  FLASH_SALE_JOB_RETRY,
  FLASH_SALE_REFUND_QUEUE,
} from './flash-sale-queues.constants';

interface OutboxRow {
  id: string;
  type: string;
  aggregate_id: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

function asObject(value: Prisma.JsonValue): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Outbox payload must be a JSON object');
  }
  return value as Record<string, unknown>;
}

@Injectable()
export class FlashSaleOutboxDispatcherService {
  private readonly logger = new Logger(FlashSaleOutboxDispatcherService.name);
  private busy = false;

  constructor(
    private readonly prisma: AppPrismaService,
    private readonly orderQueues: OrderQueuesService,
    private readonly lifecycle: FlashSaleLifecycleService,
    @InjectQueue(FLASH_SALE_EXPIRATION_QUEUE)
    private readonly expirationQueue: Queue,
    @InjectQueue(FLASH_SALE_REFUND_QUEUE)
    private readonly refundQueue: Queue,
  ) {}

  @Interval(1000)
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.dispatchBatch();
    } catch (error) {
      this.logger.error(
        `Outbox dispatch batch failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.busy = false;
    }
  }

  async dispatchBatch() {
    // SKIP LOCKED allows multiple NestJS instances to share the outbox safely.
    const events = await this.prisma.$transaction(async (tx) => {
      return tx.$queryRaw<OutboxRow[]>`
        WITH candidates AS (
          SELECT "id"
          FROM "outbox_events"
          WHERE "delivered_at" IS NULL
            AND "available_at" <= clock_timestamp()
            AND ("locked_at" IS NULL OR "locked_at" < clock_timestamp() - INTERVAL '30 seconds')
          ORDER BY "available_at" ASC, "created_at" ASC
          LIMIT 100
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "outbox_events" AS event
        SET "locked_at" = clock_timestamp(),
            "attempts" = event."attempts" + 1
        FROM candidates
        WHERE event."id" = candidates."id"
        RETURNING event."id", event."type", event."aggregate_id", event."payload", event."attempts"
      `;
    });

    for (const event of events) {
      try {
        await this.publish(event);
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { deliveredAt: new Date(), lockedAt: null, lastError: null },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        const retryMs = Math.min(5 * 60_000, 1000 * 2 ** Math.min(event.attempts, 8));
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            lockedAt: null,
            availableAt: new Date(Date.now() + retryMs),
            lastError: message.slice(0, 1900),
          },
        });
        this.logger.warn(`Outbox event ${event.id} will retry: ${message}`);
      }
    }

    return { claimed: events.length };
  }

  private async publish(event: OutboxRow) {
    const payload = asObject(event.payload);

    switch (event.type) {
      case 'FLASH_SALE_MIRROR_CONFIRM':
      case 'FLASH_SALE_MIRROR_RELEASE': {
        await this.lifecycle.applyMirrorMutationFromOutbox(payload);
        return;
      }

      case 'FLASH_SALE_RESERVATION_EXPIRE': {
        const reservationId = String(payload.reservationId ?? '');
        const expiresAt = Date.parse(String(payload.expiresAt ?? ''));
        if (!reservationId || !Number.isFinite(expiresAt)) {
          throw new Error('Invalid reservation expiry outbox payload');
        }
        await this.expirationQueue.add(
          'expire-reservation',
          { reservationId, correlationId: String(payload.correlationId ?? event.aggregate_id) },
          {
            ...FLASH_SALE_JOB_RETRY,
            jobId: `fs-expire-${reservationId}`,
            delay: Math.max(0, expiresAt - Date.now()),
          },
        );
        return;
      }

      case 'ORDER_STATUS_CHANGED': {
        const historyId = String(payload.historyId ?? '');
        if (!historyId) {
          // Do not mark an event delivered if it cannot trigger its notification.
          throw new Error('ORDER_STATUS_CHANGED outbox event has no historyId');
        }
        const correlationId = String(payload.correlationId ?? historyId);
        await this.orderQueues.notifyStatusChange(historyId, correlationId);
        return;
      }

      case 'PAYMENT_REFUND_REQUESTED': {
        const paymentIntentId = String(payload.paymentIntentId ?? '');
        const orderId = String(payload.orderId ?? '');
        const eventId = String(payload.eventId ?? '');
        const reason = String(payload.reason ?? 'Late payment requires refund');
        if (!paymentIntentId || !orderId || !eventId) {
          throw new Error('Invalid refund outbox payload');
        }
        await this.refundQueue.add(
          'refund-payment',
          { paymentIntentId, orderId, eventId, reason, correlationId: String(payload.correlationId ?? eventId) },
          {
            ...FLASH_SALE_JOB_RETRY,
            jobId: `refund-${paymentIntentId}`,
          },
        );
        return;
      }

      default:
        throw new Error(`Unknown outbox event type: ${event.type}`);
    }
  }
}
