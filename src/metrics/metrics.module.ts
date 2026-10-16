import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';

import { OrdersModule } from '../orders/orders.module';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { FlashSaleModule } from '../flash-sale/flash-sale.module';

@Module({
  imports: [OrdersModule, FlashSaleModule],
  controllers: [MetricsController],
  providers: [MetricsService, HttpMetricsMiddleware],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(HttpMetricsMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
