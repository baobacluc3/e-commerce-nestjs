import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { AuthModule } from '../auth/auth.module';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { OrdersModule } from '../orders/orders.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { RedisModule } from '../redis/redis.module';
import { FlashSaleController } from './flash-sale.controller';
import { FlashSaleOrdersController } from './flash-sale-orders.controller';
import { FlashSaleExpirationProcessor } from './flash-sale-expiration.processor';
import { FlashSaleLifecycleService } from './flash-sale-lifecycle.service';
import { FlashSaleOutboxDispatcherService } from './flash-sale-outbox-dispatcher.service';
import { FlashSaleRedisMirrorService } from './flash-sale-redis-mirror.service';
import { FlashSaleRefundProcessor } from './flash-sale-refund.processor';
import { FlashSaleReservationService } from './flash-sale-reservation.service';
import { FlashSaleMetricsService } from './flash-sale.metrics';
import {
  FLASH_SALE_EXPIRATION_QUEUE,
  FLASH_SALE_REFUND_QUEUE,
} from './flash-sale-queues.constants';

@Module({
  imports: [
    AuthModule,
    OrdersModule,
    PrismaModule,
    RedisModule,
    RateLimitModule,
    BullModule.registerQueue(
      { name: FLASH_SALE_EXPIRATION_QUEUE },
      { name: FLASH_SALE_REFUND_QUEUE },
    ),
  ],
  controllers: [FlashSaleController, FlashSaleOrdersController],
  providers: [
    FlashSaleReservationService,
    FlashSaleMetricsService,
    FlashSaleRedisMirrorService,
    FlashSaleLifecycleService,
    FlashSaleExpirationProcessor,
    FlashSaleRefundProcessor,
    FlashSaleOutboxDispatcherService,
    IdempotencyInterceptor,
  ],
  exports: [
    FlashSaleReservationService,
    FlashSaleMetricsService,
    FlashSaleRedisMirrorService,
    FlashSaleLifecycleService,
  ],
})
export class FlashSaleModule {}
