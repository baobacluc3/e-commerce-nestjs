import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';
import { RATE_LIMIT_REDIS } from './rate-limit.types';

@Module({
  imports: [RedisModule],
  providers: [
    { provide: RATE_LIMIT_REDIS, useExisting: RedisService },
    RateLimitService,
    RateLimitGuard,
  ],
  exports: [RateLimitService, RateLimitGuard],
})
export class RateLimitModule {}
