import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import {
  DEAD_LETTER_QUEUE,
  ORDER_EXPIRATION_QUEUE,
  ORDER_NOTIFICATION_QUEUE,
} from './order-queues.constants';
import { OrderQueuesService } from './order-queues.service';
import { OrderExpirationProcessor } from './order-expiration.processor';
import { OrderNotificationProcessor } from './order-notification.processor';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    IdempotencyModule,
    RateLimitModule,
    BullModule.registerQueue(
      { name: ORDER_EXPIRATION_QUEUE },
      { name: ORDER_NOTIFICATION_QUEUE },
      { name: DEAD_LETTER_QUEUE },
    ),
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderQueuesService,
    OrderExpirationProcessor,
    OrderNotificationProcessor,
  ],
  exports: [OrdersService, OrderQueuesService],
})
export class OrdersModule {}
