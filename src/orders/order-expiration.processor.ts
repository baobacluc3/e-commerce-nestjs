import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { OrdersService } from './orders.service';
import { OrderQueuesService } from './order-queues.service';
import { ORDER_EXPIRATION_QUEUE } from './order-queues.constants';

interface ExpireOrderPayload {
  orderId: string;
  expiresAt: number;
}

@Processor(ORDER_EXPIRATION_QUEUE)
export class OrderExpirationProcessor extends WorkerHost {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly queues: OrderQueuesService,
  ) {
    super();
  }

  async process(job: Job<ExpireOrderPayload>) {
    if (job.name !== 'expire-pending-order')
      throw new Error(`Unknown job: ${job.name}`);
    const result = await this.ordersService.expirePendingOrder(
      job.data.orderId,
    );
    if (result.kind === 'not-due') {
      await this.queues.rescheduleExpiration(
        job.data.orderId,
        result.expiresAt,
      );
    }
    return result;
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error) {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;
    await this.queues.moveToDeadLetter(ORDER_EXPIRATION_QUEUE, job, error);
  }
}
