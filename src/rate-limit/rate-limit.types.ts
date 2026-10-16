export type RateLimitAlgorithm = 'fixed-window' | 'token-bucket';
export type RedisFailureMode = 'open' | 'closed';

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitOptions {
  algorithm: RateLimitAlgorithm;
  ip?: RateLimitPolicy;
  user?: RateLimitPolicy;
  redisFailure?: RedisFailureMode;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimitRedis {
  evalScript(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown>;
}

export const RATE_LIMIT_REDIS = 'RATE_LIMIT_REDIS';
