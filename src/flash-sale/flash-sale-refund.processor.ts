import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { OrderQueuesService } from '../orders/order-queues.service';
import { FlashSaleLifecycleService } from './flash-sale-lifecycle.service';
import { FLASH_SALE_REFUND_QUEUE } from './flash-sale-queues.constants';

interface RefundPayload {
  paymentIntentId: string;
  orderId: string;
  eventId: string;
  reason: string;
  correlationId?: string;
}

@Processor(FLASH_SALE_REFUND_QUEUE)
export class FlashSaleRefundProcessor extends WorkerHost {
  private readonly logger = new Logger(FlashSaleRefundProcessor.name);

  constructor(
    private readonly orderQueues: OrderQueuesService,
    private readonly lifecycle: FlashSaleLifecycleService,
  ) {
    super();
  }

  async process(job: Job<RefundPayload>) {
    if (job.name !== 'refund-payment') {
      throw new Error(`Unknown flash-sale refund job: ${job.name}`);
    }

    // Mock provider only. In a real integration, pass paymentIntentId as the
    // payment provider's idempotency/reference key before issuing a refund.
    this.logger.warn(
      JSON.stringify({
        event: 'flash_sale_mock_refund',
        correlationId: job.data.correlationId ?? job.data.eventId,
        paymentIntentId: job.data.paymentIntentId,
        orderId: job.data.orderId,
        sourceEventId: job.data.eventId,
        reason: job.data.reason,
      }),
    );

    const result = await this.lifecycle.completeMockRefund(
      job.data.paymentIntentId,
    );

    return { simulated: true, paymentIntentId: job.data.paymentIntentId, result };
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error) {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    await this.orderQueues.moveToDeadLetter(
      FLASH_SALE_REFUND_QUEUE,
      job,
      error,
    );
  }
}
