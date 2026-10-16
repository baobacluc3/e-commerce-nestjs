import { OnWorkerEvent, Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';

import { OrderQueuesService } from '../orders/order-queues.service';
import { FlashSaleLifecycleService } from './flash-sale-lifecycle.service';
import {
  FLASH_SALE_EXPIRATION_QUEUE,
  FLASH_SALE_JOB_RETRY,
} from './flash-sale-queues.constants';

interface ExpirationPayload {
  reservationId: string;
  correlationId?: string;
}

@Processor(FLASH_SALE_EXPIRATION_QUEUE)
export class FlashSaleExpirationProcessor extends WorkerHost {
  constructor(
    private readonly lifecycle: FlashSaleLifecycleService,
    private readonly orderQueues: OrderQueuesService,
    @InjectQueue(FLASH_SALE_EXPIRATION_QUEUE)
    private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<ExpirationPayload>) {
    if (job.name !== 'expire-reservation') {
      throw new Error(`Unknown flash-sale expiration job: ${job.name}`);
    }

    const result = await this.lifecycle.expireReservation(
      job.data.reservationId,
      job.data.correlationId,
    );
    if (result.kind === 'not-due') {
      const delay = Math.max(1, result.expiresAt.getTime() - Date.now());
      await this.queue.add(
        'expire-reservation',
        job.data,
        {
          ...FLASH_SALE_JOB_RETRY,
          jobId: `fs-expire-${job.data.reservationId}-${result.expiresAt.getTime()}`,
          delay,
        },
      );
    }
    return result;
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error) {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    await this.orderQueues.moveToDeadLetter(
      FLASH_SALE_EXPIRATION_QUEUE,
      job,
      error,
    );
  }
}
