import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';

import { ConfigModule, ConfigService } from '@nestjs/config';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/user.module';
import { CatalogModule } from './catalog/catalog.module';
import { CartModule } from './cart/cart.module';
import { OrdersModule } from './orders/orders.module';
import { InventoryModule } from './inventory/inventory.module';
import { PaymentsModule } from './payments/payments.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { MetricsModule } from './metrics/metrics.module';
import { FlashSaleModule } from './flash-sale/flash-sale.module';

@Module({
  imports: [
    PrismaModule,
    CatalogModule,
    UsersModule,
    AuthModule,
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = new URL(config.getOrThrow<string>('REDIS_URL'));
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            username: url.username
              ? decodeURIComponent(url.username)
              : undefined,
            password: url.password
              ? decodeURIComponent(url.password)
              : undefined,
            db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
            ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    CartModule,
    OrdersModule,
    InventoryModule,
    PaymentsModule,
    RateLimitModule,
    MetricsModule,
    FlashSaleModule,
  ],
})
export class AppModule {}
