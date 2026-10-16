import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { OrderQueuesService } from './order-queues.service';
import { ORDER_NOTIFICATION_QUEUE } from './order-queues.constants';

interface NotificationPayload {
  historyId: string;
  correlationId?: string;
}

@Processor(ORDER_NOTIFICATION_QUEUE)
export class OrderNotificationProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: OrderQueuesService,
  ) {
    super();
  }

  async process(job: Job<NotificationPayload>) {
    if (job.name !== 'send-order-status-email')
      throw new Error(`Unknown job: ${job.name}`);
    const history = await this.prisma.orderStatusHistory.findUnique({
      where: { id: job.data.historyId },
      select: {
        fromStatus: true,
        toStatus: true,
        reason: true,
        order: { select: { id: true, user: { select: { email: true } } } },
      },
    });
    if (!history)
      throw new Error(`Order status history not found: ${job.data.historyId}`);
    console.log(
      [
        '[FAKE EMAIL]',
        `to=${history.order.user.email}`,
        `order=${history.order.id}`,
        `from=${history.fromStatus ?? 'NONE'}`,
        `to=${history.toStatus}`,
        `reason=${history.reason}`,
        `correlationId=${job.data.correlationId ?? job.data.historyId}`,
      ].join(' | '),
    );
    return { sent: true };
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error) {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;
    await this.queues.moveToDeadLetter(ORDER_NOTIFICATION_QUEUE, job, error);
  }
}
