import {
  Body,
  Controller,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { FlashSaleCancelDto } from './flash-sale-cancel.dto';
import { FlashSaleLifecycleService } from './flash-sale-lifecycle.service';

@Controller('flash-sale/orders')
@UseGuards(JwtAuthGuard, RateLimitGuard)
@RateLimit({
  algorithm: 'token-bucket',
  ip: { limit: 20, windowMs: 60_000 },
  user: { limit: 10, windowMs: 60_000 },
  redisFailure: 'closed',
})
export class FlashSaleOrdersController {
  constructor(
    private readonly lifecycle: FlashSaleLifecycleService,
  ) {}

  @Post(':orderId/cancel')
  cancel(
    @Param('orderId') orderId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: FlashSaleCancelDto,
  ) {
    return this.lifecycle.cancelFlashSaleOrder(
      orderId,
      user.id,
      dto.reason,
    );
  }
}
