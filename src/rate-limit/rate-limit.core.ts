import { createHash } from 'node:crypto';
import type {
  RateLimitDecision,
  RateLimitOptions,
  RateLimitPolicy,
  RateLimitRedis,
} from './rate-limit.types';

const FIXED_WINDOW_SCRIPT = `
local n = tonumber(ARGV[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local entries = {}
local maxRetry = 0
for i = 1, n do
  local argIndex = 2 + (i - 1) * 2
  local limit = tonumber(ARGV[argIndex])
  local window = tonumber(ARGV[argIndex + 1])
  local windowId = math.floor(now / window)
  local key = KEYS[i] .. ':' .. windowId
  local count = tonumber(redis.call('GET', key) or '0')
  local ttl = window - (now % window)
  entries[i] = { key = key, ttl = ttl }
  if count >= limit and ttl > maxRetry then maxRetry = ttl end
end
if maxRetry > 0 then return { 0, maxRetry } end
for i = 1, n do
  local result = redis.call('INCR', entries[i].key)
  if result == 1 then redis.call('PEXPIRE', entries[i].key, entries[i].ttl) end
end
return { 1, 0 }
`;

const TOKEN_BUCKET_SCRIPT = `
local n = tonumber(ARGV[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local entries = {}
local maxRetry = 0
for i = 1, n do
  local argIndex = 2 + (i - 1) * 2
  local capacity = tonumber(ARGV[argIndex])
  local window = tonumber(ARGV[argIndex + 1])
  local storedTokens = redis.call('HGET', KEYS[i], 'tokens')
  local storedTime = redis.call('HGET', KEYS[i], 'ts')
  local tokens = capacity
  if storedTokens then
    tokens = math.min(capacity, tonumber(storedTokens) + math.max(0, now - tonumber(storedTime)) * capacity / window)
  end
  local retry = 0
  if tokens < 1 then retry = math.ceil((1 - tokens) * window / capacity) end
  if retry > maxRetry then maxRetry = retry end
  entries[i] = { key = KEYS[i], tokens = tokens, window = window }
end
for i = 1, n do
  local tokens = entries[i].tokens
  if maxRetry == 0 then tokens = tokens - 1 end
  redis.call('HSET', entries[i].key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', entries[i].key, math.max(entries[i].window * 2, 60000))
end
if maxRetry > 0 then return { 0, maxRetry } end
return { 1, 0 }
`;

interface Dimension {
  kind: 'ip' | 'user';
  identity: string;
  policy: RateLimitPolicy;
}

export async function consumeRateLimit(
  redis: RateLimitRedis,
  options: RateLimitOptions,
  scope: string,
  ip: string,
  userId?: string,
): Promise<RateLimitDecision> {
  const dimensions: Dimension[] = [];
  if (options.ip)
    dimensions.push({ kind: 'ip', identity: ip, policy: options.ip });
  if (options.user && userId)
    dimensions.push({ kind: 'user', identity: userId, policy: options.user });
  if (dimensions.length === 0) return { allowed: true, retryAfterMs: 0 };

  const keys = dimensions.map(({ kind, identity }) => {
    const identityHash = createHash('sha256').update(identity).digest('hex');
    return ['rate-limit:v1', options.algorithm, scope, kind, identityHash].join(
      ':',
    );
  });
  const args: number[] = [dimensions.length];
  for (const dimension of dimensions)
    args.push(dimension.policy.limit, dimension.policy.windowMs);
  const script =
    options.algorithm === 'fixed-window'
      ? FIXED_WINDOW_SCRIPT
      : TOKEN_BUCKET_SCRIPT;
  const result = await redis.evalScript(script, keys, args);
  if (!Array.isArray(result) || result.length !== 2) {
    throw new Error('Unexpected Redis rate-limit response');
  }
  return {
    allowed: Number(result[0]) === 1,
    retryAfterMs: Math.max(0, Number(result[1])),
  };
}
