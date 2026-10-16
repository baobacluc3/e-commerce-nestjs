import { Inject, Injectable } from '@nestjs/common';
import { RATE_LIMIT_REDIS } from './rate-limit.types';
import type { RateLimitOptions, RateLimitRedis } from './rate-limit.types';
import { consumeRateLimit } from './rate-limit.core';

@Injectable()
export class RateLimitService {
  constructor(
    @Inject(RATE_LIMIT_REDIS) private readonly redis: RateLimitRedis,
  ) {}

  consume(
    options: RateLimitOptions,
    scope: string,
    ip: string,
    userId?: string,
  ) {
    return consumeRateLimit(this.redis, options, scope, ip, userId);
  }
}
