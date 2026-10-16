import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrderPaginationDto } from './dto/order-pagination.dto';
import { OrdersService } from './orders.service';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { IdempotencyRequest } from '../idempotency/idempotency-request.decorator';
import type { IdempotencyContext } from '../idempotency/idempotency.types';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'token-bucket',
    ip: { limit: 20, windowMs: 60_000 },
    user: { limit: 5, windowMs: 60_000 },
    redisFailure: 'closed',
  })
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @CurrentUser() user: { id: string },
    @IdempotencyRequest() idempotency: IdempotencyContext,
  ) {
    return this.ordersService.createFromCart(user.id, idempotency);
  }

  @Post(':id/cancel')
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'token-bucket',
    ip: { limit: 20, windowMs: 60_000 },
    user: { limit: 5, windowMs: 60_000 },
    redisFailure: 'closed',
  })
  cancel(
    @CurrentUser() user: { id: string },
    @Param('id') orderId: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.ordersService.cancelMyOrder(
      orderId,
      user.id,
      dto.reason ?? 'Customer requested cancellation',
    );
  }

  @Get()
  findMyOrders(
    @CurrentUser() user: { id: string },
    @Query() query: OrderPaginationDto,
  ) {
    return this.ordersService.findMyOrders(user.id, query.page, query.limit);
  }
}
