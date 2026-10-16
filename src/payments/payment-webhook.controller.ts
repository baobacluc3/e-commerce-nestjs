import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentWebhookService } from './payment-webhook.service';
import { UseGuards } from '@nestjs/common';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@Controller('webhooks')
export class PaymentWebhookController {
  constructor(private readonly webhookService: PaymentWebhookService) {}

  @Post('payment')
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'token-bucket',
    ip: { limit: 60, windowMs: 60_000 },
    redisFailure: 'closed',
  })
  @HttpCode(HttpStatus.OK)
  handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-payment-signature') signature?: string,
  ) {
    if (!request.rawBody) {
      throw new InternalServerErrorException(
        'Raw request body is not configured',
      );
    }
    return this.webhookService.handleWebhook(request.rawBody, signature);
  }
}
