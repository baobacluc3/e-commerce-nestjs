import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

import { PrismaService } from '../prisma/prisma.service';
import { FLASH_SALE_EXPIRATION_QUEUE, FLASH_SALE_REFUND_QUEUE } from './flash-sale-queues.constants';

/** Metrics for Flash Sale. Merge this registry's output into the existing /metrics endpoint. */
@Injectable()
export class FlashSaleMetricsService {
  readonly registry = new Registry();
  private readonly logger = new Logger(FlashSaleMetricsService.name);

  private readonly reservationAttempts: Counter<string>;
  private readonly reservationDuration: Histogram<string>;
  private readonly webhookEvents: Counter<string>;
  private readonly latePaymentRefunds: Counter<string>;
  private readonly mirrorFailures: Counter<string>;
  private readonly expiredReservations: Counter<string>;
  private readonly outboxPending: Gauge<string>;
  private readonly outboxOldestAge: Gauge<string>;
  private readonly reconciliationFailures: Counter<string>;
  private readonly queueJobs: Gauge<string>;
  private readonly queueMetricsUp: Gauge<string>;
  private readonly redisScriptDuration: Histogram<string>;
  private readonly databaseTransactionDuration: Histogram<string>;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(FLASH_SALE_EXPIRATION_QUEUE)
    private readonly expirationQueue: Queue,
    @InjectQueue(FLASH_SALE_REFUND_QUEUE)
    private readonly refundQueue: Queue,
  ) {
    this.reservationAttempts = new Counter({
      name: 'flash_sale_reservation_attempts_total',
      help: 'Flash-sale reservation attempts by outcome',
      labelNames: ['outcome'],
      registers: [this.registry],
    });

    this.reservationDuration = new Histogram({
      name: 'flash_sale_reservation_duration_seconds',
      help: 'End-to-end flash-sale reservation latency',
      labelNames: ['outcome'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.webhookEvents = new Counter({
      name: 'flash_sale_payment_webhook_events_total',
      help: 'Verified flash-sale payment webhooks by type and outcome',
      labelNames: ['event_type', 'outcome'],
      registers: [this.registry],
    });

    this.latePaymentRefunds = new Counter({
      name: 'flash_sale_late_payment_refund_required_total',
      help: 'Successful payments recorded after a reservation is no longer payable',
      registers: [this.registry],
    });

    this.mirrorFailures = new Counter({
      name: 'flash_sale_redis_mirror_failures_total',
      help: 'Redis mirror mutations that failed after a database commit',
      labelNames: ['operation'],
      registers: [this.registry],
    });

    this.expiredReservations = new Counter({
      name: 'flash_sale_reservations_expired_total',
      help: 'Reservations expired or released by the DB-time recovery path',
      labelNames: ['outcome'],
      registers: [this.registry],
    });

    this.outboxPending = new Gauge({
      name: 'flash_sale_outbox_pending_events',
      help: 'Number of currently undelivered outbox events',
      registers: [this.registry],
    });

    this.outboxOldestAge = new Gauge({
      name: 'flash_sale_outbox_oldest_age_seconds',
      help: 'Age of the oldest undelivered outbox event in seconds',
      registers: [this.registry],
    });

    this.reconciliationFailures = new Counter({
      name: 'flash_sale_reconciliation_failures_total',
      help: 'Flash-sale Redis/DB reconciliation failures',
      labelNames: ['operation'],
      registers: [this.registry],
    });

    this.queueJobs = new Gauge({
      name: 'flash_sale_queue_jobs',
      help: 'Flash-sale BullMQ jobs by queue and state',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
    });

    this.queueMetricsUp = new Gauge({
      name: 'flash_sale_queue_metrics_up',
      help: 'Whether Flash-sale BullMQ queue counts could be collected',
      registers: [this.registry],
    });

    this.redisScriptDuration = new Histogram({
      name: 'flash_sale_redis_script_duration_seconds',
      help: 'Flash-sale Redis Lua execution duration',
      labelNames: ['script', 'outcome'],
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [this.registry],
    });

    this.databaseTransactionDuration = new Histogram({
      name: 'flash_sale_database_transaction_duration_seconds',
      help: 'Flash-sale database transaction duration',
      labelNames: ['operation', 'outcome'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });
  }

  recordReservation(outcome: string, durationSeconds: number) {
    this.reservationAttempts.labels(outcome).inc();
    this.reservationDuration.labels(outcome).observe(
      Math.max(0, durationSeconds),
    );
  }

  recordWebhook(eventType: string, outcome: string) {
    this.webhookEvents.labels(eventType, outcome).inc();
    if (outcome === 'ORDER_CANCELLED_REFUND_REQUIRED') {
      this.latePaymentRefunds.inc();
    }
  }

  recordMirrorFailure(operation: string) {
    this.mirrorFailures.labels(operation).inc();
  }

  recordExpiration(outcome: string) {
    this.expiredReservations.labels(outcome).inc();
  }

  recordReconciliationFailure(operation: string) {
    this.reconciliationFailures.labels(operation).inc();
  }

  recordRedisScript(script: string, outcome: string, durationSeconds: number) {
    this.redisScriptDuration.labels(script, outcome).observe(Math.max(0, durationSeconds));
  }

  recordDatabaseTransaction(operation: string, outcome: string, durationSeconds: number) {
    this.databaseTransactionDuration.labels(operation, outcome).observe(Math.max(0, durationSeconds));
  }

  /** Keep DB/queue gauges current without putting SQL in a Prometheus scrape. */
  @Interval(10_000)
  async refreshOutboxGauges() {
    try {
      const rows = await this.prisma.$queryRaw<Array<{
        pending: bigint;
        oldest_age_seconds: number | null;
      }>>`
        SELECT
          COUNT(*)::bigint AS "pending",
          COALESCE(
            EXTRACT(EPOCH FROM (clock_timestamp() - MIN("created_at"))),
            0
          )::float8 AS "oldest_age_seconds"
        FROM "outbox_events"
        WHERE "delivered_at" IS NULL
      `;

      this.outboxPending.set(Number(rows[0]?.pending ?? 0));
      this.outboxOldestAge.set(Number(rows[0]?.oldest_age_seconds ?? 0));

      this.queueJobs.reset();
      const queues = [
        { name: FLASH_SALE_EXPIRATION_QUEUE, queue: this.expirationQueue },
        { name: FLASH_SALE_REFUND_QUEUE, queue: this.refundQueue },
      ];
      for (const item of queues) {
        const counts = await item.queue.getJobCounts('wait', 'active', 'delayed', 'failed');
        for (const state of ['wait', 'active', 'delayed', 'failed'] as const) {
          const labelState = state === 'wait' ? 'waiting' : state;
          this.queueJobs.labels(item.name, labelState).set(counts[state] ?? 0);
        }
      }
      this.queueMetricsUp.set(1);
    } catch (error) {
      this.queueMetricsUp.set(0);
      // Metrics collection must not affect checkout availability.
      this.logger.warn(
        `Could not refresh outbox gauges: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
