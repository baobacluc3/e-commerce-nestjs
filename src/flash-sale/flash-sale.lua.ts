/**
 * Redis is an admission/mirror layer only. PostgreSQL remains authoritative.
 * All keys touched by each script share the same Redis Cluster hash tag:
 * {campaignId}
 */

export const RESERVE_LUA = String.raw`
local ready = redis.call('GET', KEYS[1])
if ready ~= '1' then
  return {-1, 0} -- campaign mirror is not ready: fail closed
end

local reservationId = ARGV[1]
local userId = ARGV[2]
local campaignId = ARGV[3]
local holdMs = tonumber(ARGV[4])
local provisionalLeaseMs = tonumber(ARGV[5])
local items = cjson.decode(ARGV[6])
local userLimit = tonumber(redis.call('HGET', KEYS[5], 'perUserLimit'))
if not userLimit then
  return {-1, 0} -- incomplete campaign configuration mirror
end

if redis.call('EXISTS', KEYS[2]) == 1 then
  return {-2, 0} -- reservation ID already used
end

local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local expiresAtMs = nowMs + holdMs
local provisionalUntilMs = nowMs + provisionalLeaseMs

local requestedTotal = 0
for i, item in ipairs(items) do
  if type(item.productId) ~= 'string' or type(item.quantity) ~= 'number'
      or item.quantity < 1 or item.quantity ~= math.floor(item.quantity) then
    return {-5, 0} -- invalid request
  end
  requestedTotal = requestedTotal + item.quantity
  local stockKeyIndex = 5 + i
  local available = tonumber(redis.call('HGET', KEYS[stockKeyIndex], 'available'))
  local reserved = tonumber(redis.call('HGET', KEYS[stockKeyIndex], 'reserved'))
  local sold = tonumber(redis.call('HGET', KEYS[stockKeyIndex], 'sold'))
  local allocated = tonumber(redis.call('HGET', KEYS[stockKeyIndex], 'allocated'))
  if not available or not reserved or not sold or not allocated then
    return {-4, 0} -- missing stock mirror
  end
  if available < 0 or reserved < 0 or sold < 0 or
      available + reserved + sold ~= allocated then
    return {-4, 0} -- broken mirror invariant: fail closed
  end
  if available < item.quantity then
    return {0, 0} -- sold out
  end
end

local active = tonumber(redis.call('HGET', KEYS[4], 'activeQuantity') or '0')
local purchased = tonumber(redis.call('HGET', KEYS[4], 'purchasedQuantity') or '0')
if active < 0 or purchased < 0 or active + purchased > userLimit then
  return {-4, 0} -- quota mirror invariant is broken: fail closed
end
if active + purchased + requestedTotal > userLimit then
  return {-3, 0} -- per-user campaign quota exceeded
end

-- No state is changed until every item and the user quota have passed.
for i, item in ipairs(items) do
  local stockKeyIndex = 5 + i
  redis.call('HINCRBY', KEYS[stockKeyIndex], 'available', -item.quantity)
  redis.call('HINCRBY', KEYS[stockKeyIndex], 'reserved', item.quantity)
end
redis.call('HSET', KEYS[4], 'activeQuantity', active + requestedTotal)
redis.call('HSET', KEYS[2],
  'id', reservationId,
  'userId', userId,
  'campaignId', campaignId,
  'status', 'PROVISIONAL',
  'items', ARGV[6],
  'quantity', requestedTotal,
  'expiresAtMs', expiresAtMs,
  'provisionalUntilMs', provisionalUntilMs)
redis.call('PEXPIRE', KEYS[2], 2592000000) -- 30 days for repair/audit window
redis.call('ZADD', KEYS[3], provisionalUntilMs, reservationId)
return {1, expiresAtMs, provisionalUntilMs}
`;

export const FINALIZE_RESERVATION_LUA = String.raw`
local status = redis.call('HGET', KEYS[1], 'status')
local expiresAtMs = tonumber(ARGV[1])
if not expiresAtMs then
  return {-1, 0}
end
-- Idempotent under multiple reconcilers: don't demote a reservation that
-- another worker already finalized/confirmed.
if status == 'ACTIVE' or status == 'CONFIRMED' then
  redis.call('ZREM', KEYS[2], ARGV[2])
  if status == 'ACTIVE' then
    redis.call('ZADD', KEYS[3], expiresAtMs, ARGV[2])
  else
    redis.call('ZREM', KEYS[3], ARGV[2])
  end
  return {1, expiresAtMs}
end
if status ~= 'PROVISIONAL' then
  return {0, 0}
end
redis.call('HSET', KEYS[1], 'status', 'ACTIVE', 'expiresAtMs', expiresAtMs)
redis.call('HDEL', KEYS[1], 'provisionalUntilMs')
-- KEYS: reservation, provisional-zset, active-expiry-zset
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], expiresAtMs, ARGV[2])
return {1, expiresAtMs}
`;

/**
 * Release is idempotent. `expectedStatus` must be exactly PROVISIONAL for
 * DB-compensation or ACTIVE for expiry. Replaying a completed release is a no-op.
 */
export const RELEASE_RESERVATION_LUA = String.raw`
local reservationId = ARGV[1]
local expectedStatus = ARGV[2]
local targetStatus = ARGV[3]
local status = redis.call('HGET', KEYS[1], 'status')
-- A repeated release for the same terminal target is successful but does
-- not change counters a second time.
if status == targetStatus then
  redis.call('ZREM', KEYS[2], reservationId)
  redis.call('ZREM', KEYS[3], reservationId)
  return {1, 0}
end
if status ~= expectedStatus then
  return {0, 0}
end
local itemsRaw = redis.call('HGET', KEYS[1], 'items')
if not itemsRaw then
  return {-1, 0}
end
local items = cjson.decode(itemsRaw)
local total = 0
-- KEYS: reservation, provisional-zset, active-expiry-zset, quota, stock...
for i, item in ipairs(items) do
  local stockKeyIndex = 4 + i
  local reserved = tonumber(redis.call('HGET', KEYS[stockKeyIndex], 'reserved'))
  local available = tonumber(redis.call('HGET', KEYS[stockKeyIndex], 'available'))
  local allocated = tonumber(redis.call('HGET', KEYS[stockKeyIndex], 'allocated'))
  if not reserved or not available or not allocated or
      reserved < item.quantity or available + item.quantity > allocated then
    return {-2, 0}
  end
  total = total + item.quantity
end
local quotaActive = tonumber(redis.call('HGET', KEYS[4], 'activeQuantity') or '0')
if quotaActive < total then
  return {-3, 0}
end
for i, item in ipairs(items) do
  local stockKeyIndex = 4 + i
  redis.call('HINCRBY', KEYS[stockKeyIndex], 'reserved', -item.quantity)
  redis.call('HINCRBY', KEYS[stockKeyIndex], 'available', item.quantity)
end
redis.call('HSET', KEYS[4], 'activeQuantity', quotaActive - total)
redis.call('HSET', KEYS[1], 'status', targetStatus)
redis.call('ZREM', KEYS[2], reservationId)
redis.call('ZREM', KEYS[3], reservationId)
return {1, total}
`;

/** Used only to update the Redis mirror after the authoritative DB transaction commits. */
export const CONFIRM_RESERVATION_LUA = String.raw`
local reservationId = ARGV[1]
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'CONFIRMED' then
  redis.call('ZREM', KEYS[2], reservationId)
  redis.call('ZREM', KEYS[3], reservationId)
  return {1, 0}
end
if status ~= 'ACTIVE' then
  return {0, 0}
end
local itemsRaw = redis.call('HGET', KEYS[1], 'items')
if not itemsRaw then
  return {-1, 0}
end
local items = cjson.decode(itemsRaw)
local total = 0
-- KEYS: reservation, provisional-zset, active-expiry-zset, quota, stock...
for i, item in ipairs(items) do
  local stockKeyIndex = 4 + i
  local reserved = tonumber(redis.call('HGET', KEYS[stockKeyIndex], 'reserved'))
  local sold = tonumber(redis.call('HGET', KEYS[stockKeyIndex], 'sold'))
  local allocated = tonumber(redis.call('HGET', KEYS[stockKeyIndex], 'allocated'))
  if not reserved or not sold or not allocated or
      reserved < item.quantity or sold + item.quantity > allocated then
    return {-2, 0}
  end
  total = total + item.quantity
end
local active = tonumber(redis.call('HGET', KEYS[4], 'activeQuantity') or '0')
if active < total then
  return {-3, 0}
end
for i, item in ipairs(items) do
  local stockKeyIndex = 4 + i
  redis.call('HINCRBY', KEYS[stockKeyIndex], 'reserved', -item.quantity)
  redis.call('HINCRBY', KEYS[stockKeyIndex], 'sold', item.quantity)
end
local purchased = tonumber(redis.call('HGET', KEYS[4], 'purchasedQuantity') or '0')
redis.call('HSET', KEYS[4],
  'activeQuantity', active - total,
  'purchasedQuantity', purchased + total)
redis.call('HSET', KEYS[1], 'status', 'CONFIRMED')
redis.call('ZREM', KEYS[2], reservationId)
redis.call('ZREM', KEYS[3], reservationId)
return {1, total}
`;

/**
 * Maintenance-only mirror rebuild. Call only after closing the campaign gate
 * and pausing reservation/payment/expiry mutations for that campaign. The DB
 * snapshot must remain stable until this atomic script finishes.
 */
export const REBUILD_CAMPAIGN_MIRROR_LUA = String.raw`
local campaignId = ARGV[1]
local perUserLimit = tonumber(ARGV[2])
local stocks = cjson.decode(ARGV[3])
local quotas = cjson.decode(ARGV[4])
local reservations = cjson.decode(ARGV[5])
local readyKey = KEYS[1]

redis.call('SET', readyKey, '0')
for i = 2, #KEYS do
  redis.call('DEL', KEYS[i])
end

local configKey = 'fs:{' .. campaignId .. '}:config'
local expiryKey = 'fs:{' .. campaignId .. '}:expiry'
redis.call('HSET', configKey, 'perUserLimit', perUserLimit)

for _, stock in ipairs(stocks) do
  local key = 'fs:{' .. campaignId .. '}:stock:' .. stock.productId
  redis.call('HSET', key,
    'allocated', stock.allocated,
    'available', stock.available,
    'reserved', stock.reserved,
    'sold', stock.sold,
    'version', stock.version)
end

for _, quota in ipairs(quotas) do
  local key = 'fs:{' .. campaignId .. '}:quota:' .. quota.userId
  redis.call('HSET', key,
    'activeQuantity', quota.activeQuantity,
    'purchasedQuantity', quota.purchasedQuantity)
end

for _, reservation in ipairs(reservations) do
  local key = 'fs:{' .. campaignId .. '}:reservation:' .. reservation.id
  redis.call('HSET', key,
    'id', reservation.id,
    'userId', reservation.userId,
    'campaignId', campaignId,
    'status', reservation.status,
    'items', cjson.encode(reservation.items),
    'quantity', reservation.quantity,
    'expiresAtMs', reservation.expiresAtMs)
  redis.call('PEXPIRE', key, 2592000000)
  redis.call('ZADD', expiryKey, reservation.expiresAtMs, reservation.id)
end

-- Keep the write gate closed. An operator opens it only after checking DB
-- invariants and making the campaign ACTIVE.
redis.call('SET', readyKey, '0')
return {1, #stocks, #quotas, #reservations}
`;


export const LIST_DUE_PROVISIONALS_LUA = String.raw`
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', nowMs, 'LIMIT', 0, 100)
local result = {}
local campaignId = ARGV[1]
for _, reservationId in ipairs(ids) do
  local reservationKey = 'fs:{' .. campaignId .. '}:reservation:' .. reservationId
  local status = redis.call('HGET', reservationKey, 'status')
  local lease = tonumber(redis.call('HGET', reservationKey, 'provisionalUntilMs') or '0')
  if status == 'PROVISIONAL' and lease > 0 and lease <= nowMs then
    table.insert(result, reservationId)
  end
end
return result
`;

export const GET_RESERVATION_MIRROR_LUA = String.raw`
local status = redis.call('HGET', KEYS[1], 'status')
local userId = redis.call('HGET', KEYS[1], 'userId')
local campaignId = redis.call('HGET', KEYS[1], 'campaignId')
local expiryScore = nil
local provisionalScore = nil
if campaignId then
  local expiryKey = 'fs:{' .. campaignId .. '}:expiry'
  local provisionalKey = 'fs:{' .. campaignId .. '}:provisional'
  expiryScore = redis.call('ZSCORE', expiryKey, redis.call('HGET', KEYS[1], 'id'))
  provisionalScore = redis.call('ZSCORE', provisionalKey, redis.call('HGET', KEYS[1], 'id'))
end
local result = {
  status = status,
  userId = userId,
  campaignId = campaignId,
  items = redis.call('HGET', KEYS[1], 'items'),
  expiresAtMs = redis.call('HGET', KEYS[1], 'expiresAtMs'),
  expiryScore = expiryScore,
  provisionalScore = provisionalScore
}
return cjson.encode(result)
`;
