import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { consumeRateLimit } from './rate-limit.core';

const testRedisUrl = process.env.RATE_LIMIT_TEST_REDIS_URL;
const describeRedis = testRedisUrl ? describe : describe.skip;

describeRedis.each(['fixed-window', 'token-bucket'] as const)(
  '%s rate limiting with dedicated Redis',
  (algorithm) => {
    let redis: Redis;

    beforeAll(() => {
      redis = new Redis(testRedisUrl!, { maxRetriesPerRequest: 1 });
    });

    afterAll(async () => {
      await redis?.quit();
    });

    it('allows exactly five of ten simultaneous requests', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          consumeRateLimit(
            {
              evalScript: (script, keys, args) =>
                redis.eval(script, keys.length, ...keys, ...args.map(String)),
            },
            {
              algorithm,
              ip: { limit: 5, windowMs: 10_000 },
              redisFailure: 'closed',
            },
            `test:${randomUUID()}`,
            'test-client-ip',
          ),
        ),
      );
      expect(results.filter((result) => result.allowed)).toHaveLength(5);
      const rejected = results.filter((result) => !result.allowed);
      expect(rejected).toHaveLength(5);
      for (const result of rejected)
        expect(result.retryAfterMs).toBeGreaterThan(0);
    });
  },
);
