import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { PaymentIntentStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SimulatePaymentDto } from './dto/simulate-payment.dto';

@Injectable()
export class MockPaymentGatewayService implements OnModuleDestroy {
  private readonly logger = new Logger(MockPaymentGatewayService.name);
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async scheduleSuccess(
    paymentIntentId: string,
    userId: string,
    options: SimulatePaymentDto,
  ) {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new ForbiddenException('Mock payments are disabled in production');
    }
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      select: {
        id: true,
        providerReference: true,
        amount: true,
        currency: true,
        status: true,
        order: { select: { userId: true } },
      },
    });
    if (!intent || intent.order.userId !== userId) {
      throw new NotFoundException('Payment intent not found');
    }
    if (intent.status !== PaymentIntentStatus.PENDING) {
      throw new ConflictException('Payment intent is no longer pending');
    }

    const delayMs = options.delayMs ?? 1000 + Math.floor(Math.random() * 4001);
    const duplicateCount = options.duplicateCount ?? 1;
    const event = {
      eventId: randomUUID(),
      type: 'payment.succeeded',
      providerReference: intent.providerReference,
      amount: intent.amount.toString(),
      currency: intent.currency,
      occurredAt: new Date().toISOString(),
    };
    const rawBody = JSON.stringify(event);
    const signature = createHmac(
      'sha256',
      this.config.getOrThrow<string>('PAYMENT_WEBHOOK_SECRET'),
    )
      .update(rawBody)
      .digest('hex');

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void Promise.all(
        Array.from({ length: duplicateCount }, () =>
          this.deliverWebhook(rawBody, signature),
        ),
      ).catch((error: unknown) => {
        this.logger.error(
          `Mock webhook delivery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      });
    }, delayMs);
    this.timers.add(timer);
    return {
      scheduled: true,
      eventId: event.eventId,
      deliveries: duplicateCount,
      delayMs,
    };
  }

  private async deliverWebhook(rawBody: string, signature: string) {
    const baseUrl = this.config
      .get<string>('APP_BASE_URL', 'http://localhost:3000')
      .replace(/\/$/, '');
    const webhookUrl = this.config.get<string>(
      'PAYMENT_WEBHOOK_URL',
      `${baseUrl}/webhooks/payment`,
    );
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment-signature': `sha256=${signature}`,
      },
      body: rawBody,
    });
    if (!response.ok) {
      this.logger.warn(
        `Webhook returned ${response.status}: ${await response.text()}`,
      );
      return;
    }
    this.logger.log(`Mock webhook delivered: HTTP ${response.status}`);
  }

  onModuleDestroy() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
