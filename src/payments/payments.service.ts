import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PaymentIntentStatus, OrderStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createIntent(userId: string, orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "orders"
        WHERE "id" = ${orderId} AND "userId" = ${userId}
        FOR UPDATE
      `;
      if (locked.length === 0) throw new NotFoundException('Order not found');

      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { status: true, totalAmount: true, currency: true },
      });
      if (order.status !== OrderStatus.PENDING_PAYMENT) {
        throw new ConflictException('Order is not awaiting payment');
      }

      const existing = await tx.paymentIntent.findUnique({
        where: { orderId },
      });
      if (existing) return this.serializeIntent(existing);

      const id = randomUUID();
      const providerReference = `mock_${randomUUID()}`;
      const checkoutBase = this.config
        .get<string>(
          'MOCK_CHECKOUT_BASE_URL',
          'http://localhost:3000/payments/mock-checkout',
        )
        .replace(/\/$/, '');
      const intent = await tx.paymentIntent.create({
        data: {
          id,
          orderId,
          providerReference,
          amount: order.totalAmount,
          currency: order.currency,
          status: PaymentIntentStatus.PENDING,
          checkoutUrl: `${checkoutBase}/${id}`,
        },
      });
      return this.serializeIntent(intent);
    });
  }

  async getOwnedIntent(paymentIntentId: string, userId: string) {
    const intent = await this.prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      select: {
        id: true,
        orderId: true,
        amount: true,
        currency: true,
        status: true,
        checkoutUrl: true,
      },
    });
    if (!intent) throw new NotFoundException('Payment intent not found');
    const order = await this.prisma.order.findFirst({
      where: { id: intent.orderId, userId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Payment intent not found');
    return {
      paymentIntentId: intent.id,
      orderId: intent.orderId,
      amount: intent.amount.toString(),
      currency: intent.currency,
      status: intent.status,
      checkoutUrl: intent.checkoutUrl,
    };
  }

  private serializeIntent(intent: {
    id: string;
    orderId: string;
    amount: bigint;
    currency: string;
    status: PaymentIntentStatus;
    checkoutUrl: string;
  }) {
    return {
      paymentIntentId: intent.id,
      orderId: intent.orderId,
      amount: intent.amount.toString(),
      currency: intent.currency,
      status: intent.status,
      checkoutUrl: intent.checkoutUrl,
    };
  }
}
