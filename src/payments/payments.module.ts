import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MockPaymentGatewayService } from './mock-payment-gateway.service';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { FlashSaleModule } from '../flash-sale/flash-sale.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuthModule,
    OrdersModule,
    RateLimitModule,
    IdempotencyModule,
    FlashSaleModule,
  ],
  controllers: [PaymentsController, PaymentWebhookController],
  providers: [
    PaymentsService,
    PaymentWebhookService,
    MockPaymentGatewayService,
  ],
})
export class PaymentsModule {}
