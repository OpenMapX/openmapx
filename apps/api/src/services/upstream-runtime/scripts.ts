export const RELEASE_LEASE_SCRIPT = `
-- openmapx-release-lease
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export const CONSUME_QUOTA_SCRIPT = `
-- openmapx-consume-quota
local cost = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local denied = false
local retryAt = 0
local remaining = {}

for i = 1, #KEYS do
  local limit = tonumber(ARGV[2 + (i - 1) * 2 + 1])
  local durationMs = tonumber(ARGV[2 + (i - 1) * 2 + 2])
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  remaining[i] = math.max(0, limit - current)
  if current + cost > limit then
    denied = true
    local reset = (math.floor(now / durationMs) + 1) * durationMs
    if reset > retryAt then retryAt = reset end
  end
end

if not denied then
  for i = 1, #KEYS do
    local limit = tonumber(ARGV[2 + (i - 1) * 2 + 1])
    local durationMs = tonumber(ARGV[2 + (i - 1) * 2 + 2])
    local current = redis.call('INCRBY', KEYS[i], cost)
    if current == cost then redis.call('PEXPIRE', KEYS[i], durationMs) end
    remaining[i] = math.max(0, limit - current)
  end
end

return cjson.encode({
  allowed = not denied,
  remaining = remaining,
  retryAt = denied and retryAt or cjson.null
})
`;

export const SHARED_REQUEST_SCRIPT = `
-- openmapx-shared-request
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local key = KEYS[1]
local cooldown = tonumber(redis.call('HGET', key, 'cooldown') or '0')
local function retain(ttl)
  local existing = redis.call('PTTL', key)
  redis.call('PEXPIRE', key, math.max(existing, ttl))
end
local function deny(reason, untilAt)
  return {0, reason, string.format('%.0f', untilAt - now)}
end

if ARGV[1] == 'defer' then
  local delay = tonumber(ARGV[2])
  if now + delay > 9007199254740991 then return redis.error_reply('Unsafe delay') end
  local untilAt = math.max(cooldown, now + delay)
  if untilAt > now then
    redis.call('HSET', key, 'cooldown', untilAt)
    retain(untilAt - now)
  end
  return 1
end

if cooldown > now then return deny('cooldown', cooldown) end
if ARGV[2] == '' then
  return {1}
end
local field = ARGV[2]
local limit = tonumber(ARGV[3])
local duration = tonumber(ARGV[4])
local interval = tonumber(ARGV[5])
if now + math.max(duration, interval) > 9007199254740991 then
  return redis.error_reply('Unsafe policy duration')
end
local start = tonumber(redis.call('HGET', key, field .. ':start') or now)
local count = tonumber(redis.call('HGET', key, field .. ':count') or '0')
local nextAt = tonumber(redis.call('HGET', key, field .. ':next') or '0')
if now >= start + duration then
  start = now
  count = 0
end
if count >= limit then return deny('quota', start + duration) end
if nextAt > now then return deny('spacing', nextAt) end
redis.call('HSET', key,
  field .. ':start', start,
  field .. ':count', count + 1,
  field .. ':next', now + interval)
retain(math.max(start + duration - now, interval, cooldown - now))
return {1, string.format('%.0f', limit - count - 1)}
`;
