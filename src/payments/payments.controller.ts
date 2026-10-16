import { Body, Controller, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MockPaymentGatewayService } from './mock-payment-gateway.service';
import { PaymentsService } from './payments.service';
import { SimulatePaymentDto } from './dto/simulate-payment.dto';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly mockGateway: MockPaymentGatewayService,
  ) {}

  @Post('orders/:orderId/intent')
  @UseInterceptors(IdempotencyInterceptor)
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'token-bucket',
    ip: { limit: 30, windowMs: 60_000 },
    user: { limit: 10, windowMs: 60_000 },
    redisFailure: 'closed',
  })
  createIntent(
    @CurrentUser() user: { id: string },
    @Param('orderId') orderId: string,
  ) {
    return this.paymentsService.createIntent(user.id, orderId);
  }

  @Get('mock-checkout/:paymentIntentId')
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'token-bucket',
    ip: { limit: 30, windowMs: 60_000 },
    user: { limit: 10, windowMs: 60_000 },
    redisFailure: 'closed',
  })
  getMockCheckout(
    @CurrentUser() user: { id: string },
    @Param('paymentIntentId') paymentIntentId: string,
  ) {
    return this.paymentsService.getOwnedIntent(paymentIntentId, user.id);
  }

  @Post('mock/:paymentIntentId/simulate-success')
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'token-bucket',
    ip: { limit: 30, windowMs: 60_000 },
    user: { limit: 10, windowMs: 60_000 },
    redisFailure: 'closed',
  })
  simulateSuccess(
    @CurrentUser() user: { id: string },
    @Param('paymentIntentId') paymentIntentId: string,
    @Body() dto?: SimulatePaymentDto,
  ) {
    return this.mockGateway.scheduleSuccess(
      paymentIntentId,
      user.id,
      dto ?? new SimulatePaymentDto(),
    );
  }
}
