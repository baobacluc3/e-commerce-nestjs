import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

import { OrderQueuesService } from '../orders/order-queues.service';
import { FlashSaleMetricsService } from '../flash-sale/flash-sale.metrics';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly requestCount: Counter<string>;
  private readonly requestDuration: Histogram<string>;
  private readonly queueJobs: Gauge<string>;
  private readonly queueMetricsUp: Gauge<string>;

  constructor(
    private readonly orderQueues: OrderQueuesService,
    private readonly flashSaleMetrics: FlashSaleMetricsService,
  ) {
    collectDefaultMetrics({ register: this.registry, prefix: 'nestjs_' });

    this.requestCount = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests received by the application',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.requestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.queueMetricsUp = new Gauge({
      name: 'bullmq_queue_metrics_up',
      help: 'Whether BullMQ queue-depth collection succeeded',
      registers: [this.registry],
    });

    this.queueJobs = new Gauge({
      name: 'bullmq_queue_jobs',
      help: 'BullMQ jobs by queue and state',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
      collect: async () => {
        this.queueJobs.reset();
        try {
          const queues = await this.orderQueues.getQueueDepths();
          for (const queue of queues) {
            for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
              this.queueJobs.labels(queue.queue, state).set(queue[state]);
            }
          }
          this.queueMetricsUp.set(1);
        } catch {
          // Preserve scrape availability when Redis is unavailable.
          this.queueMetricsUp.set(0);
        }
      },
    });
  }

  observeRequest(method: string, route: string, statusCode: number, durationSeconds: number) {
    const labels = { method, route, status_code: String(statusCode) };
    this.requestCount.inc(labels);
    this.requestDuration.observe(labels, durationSeconds);
  }

  async getMetrics() {
    const [base, flashSale] = await Promise.all([
      this.registry.metrics(),
      this.flashSaleMetrics.registry.metrics(),
    ]);
    return `${base}\n${flashSale}`;
  }

  getContentType() {
    return this.registry.contentType;
  }
}
