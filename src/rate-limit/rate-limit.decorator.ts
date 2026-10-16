import { SetMetadata } from '@nestjs/common';
import { RateLimitOptions } from './rate-limit.types';

export const RATE_LIMIT_KEY = 'rate-limit-options';

export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);
