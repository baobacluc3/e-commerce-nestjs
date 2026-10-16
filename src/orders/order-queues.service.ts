import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import {
  DEAD_LETTER_QUEUE,
  ORDER_EXPIRATION_QUEUE,
  ORDER_NOTIFICATION_QUEUE,
  PAYMENT_TIMEOUT_MS,
  RETRY_OPTIONS,
} from './order-queues.constants';

@Injectable()
export class OrderQueuesService {
  constructor(
    @InjectQueue(ORDER_EXPIRATION_QUEUE)
    private readonly expirationQueue: Queue,
    @InjectQueue(ORDER_NOTIFICATION_QUEUE)
    private readonly notificationQueue: Queue,
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetterQueue: Queue,
  ) {}

  async getQueueDepths() {
    const queues = [
      { name: ORDER_EXPIRATION_QUEUE, queue: this.expirationQueue },
      { name: ORDER_NOTIFICATION_QUEUE, queue: this.notificationQueue },
      { name: DEAD_LETTER_QUEUE, queue: this.deadLetterQueue },
    ];

    return Promise.all(
      queues.map(async ({ name, queue }) => {
        const counts = await queue.getJobCounts(
          'wait',
          'active',
          'delayed',
          'failed',
        );

        return {
          queue: name,
          waiting: counts.wait ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
        };
      }),
    );
  }

  async scheduleExpiration(orderId: string, createdAt: Date) {
    const expiresAt = createdAt.getTime() + PAYMENT_TIMEOUT_MS;
    return this.expirationQueue.add(
      'expire-pending-order',
      { orderId, expiresAt },
      {
        ...RETRY_OPTIONS,
        jobId: `expire-${orderId}`,
        delay: Math.max(0, expiresAt - Date.now()),
      },
    );
  }

  async rescheduleExpiration(orderId: string, expiresAt: number) {
    return this.expirationQueue.add(
      'expire-pending-order',
      { orderId, expiresAt },
      {
        ...RETRY_OPTIONS,
        jobId: `expire-${orderId}-${expiresAt}`,
        delay: Math.max(1, expiresAt - Date.now()),
      },
    );
  }

  async notifyStatusChange(historyId: string, correlationId?: string) {
    return this.notificationQueue.add(
      'send-order-status-email',
      { historyId, correlationId: correlationId ?? historyId },
      { ...RETRY_OPTIONS, jobId: `notify-${historyId}` },
    );
  }

  async moveToDeadLetter(originalQueue: string, job: Job, error: Error) {
    return this.deadLetterQueue.add(
      'failed-job',
      {
        originalQueue,
        originalJobId: String(job.id),
        originalJobName: job.name,
        data: job.data,
        attemptsMade: job.attemptsMade,
        error: error.message,
        failedAt: new Date().toISOString(),
      },
      {
        jobId: `dlq-${originalQueue}-${job.id}`,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
  }
}
