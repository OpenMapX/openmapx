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
