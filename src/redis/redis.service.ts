import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(
      config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
      {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
      },
    );
    this.client.on('error', (error) => {
      this.logger.warn(`Redis connection error: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async increment(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async acquireLock(
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    return (await this.client.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
  }

  async evalScript(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args.map(String));
  }

  async scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH', pattern,
        'COUNT', 500,
      );
      cursor = nextCursor;
      found.push(...keys);
    } while (cursor !== '0');
    return found;
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    return this.client.hmget(key, ...fields);
  }

  async zcard(key: string): Promise<number> {
    return this.client.zcard(key);
  }
}
