import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { IdempotencyRequest } from '../idempotency/idempotency-request.decorator';
import type { IdempotencyContext } from '../idempotency/idempotency.types';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { FlashSaleReservationService } from './flash-sale-reservation.service';
import { FlashSaleReserveDto } from './flash-sale-reserve.dto';

@Controller('flash-sale/campaigns')
@UseGuards(JwtAuthGuard)
export class FlashSaleController {
  constructor(
    private readonly reservations: FlashSaleReservationService,
  ) {}

  @Post(':campaignId/reservations')
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'token-bucket',
    ip: { limit: 20, windowMs: 60_000 },
    user: { limit: 5, windowMs: 60_000 },
    redisFailure: 'closed',
  })
  @UseInterceptors(IdempotencyInterceptor)
  reserve(
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: FlashSaleReserveDto,
    @IdempotencyRequest() idempotency: IdempotencyContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const raw = request.headers['x-correlation-id'];
    const supplied = Array.isArray(raw) ? raw[0] : raw;
    const correlationId = supplied && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied)
      ? supplied
      : randomUUID();
    response.setHeader('x-correlation-id', correlationId);

    return this.reservations.reserve(
      campaignId,
      user.id,
      dto.items,
      idempotency,
      correlationId,
    );
  }
}
