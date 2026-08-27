import { createHmac, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

const PRINCIPAL_KEY_ENCODED_BYTES = 43;
const PREPARE_WINDOW_MS = 10 * 60 * 1_000;
const PREPARE_MAX = 2;
const PRINCIPAL_PATTERN = /^[a-f0-9]{64}$/;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Load the generated API-only principal key through an already-open descriptor.
 * The exact encoded size/mode/owner/link-count checks make replacement or
 * alternate-file shapes fail closed without ever including secret bytes in an
 * error.
 */
export async function readOfflinePackagePrincipalKeyFile(path: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new Error("Offline package principal key must be a regular file");
    }
    throw new Error("Offline package principal key is missing or unreadable");
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Offline package principal key must be a regular file");
    if (stat.nlink !== 1) throw new Error("Offline package principal key must have one link");
    if ((stat.mode & 0o777) !== 0o444) {
      throw new Error("Offline package principal key must have mode 0444");
    }
    const configuredUid = process.env.OFFLINE_PACKAGE_PRINCIPAL_KEY_UID?.trim();
    const expectedUid = configuredUid
      ? Number(configuredUid)
      : typeof process.getuid === "function"
        ? process.getuid()
        : stat.uid;
    if (!Number.isSafeInteger(expectedUid) || expectedUid < 0 || stat.uid !== expectedUid) {
      throw new Error("Offline package principal key has an invalid owner");
    }
    if (stat.size !== PRINCIPAL_KEY_ENCODED_BYTES) {
      throw new Error("Offline package principal key has an invalid size");
    }
    const encodedBytes = Buffer.alloc(PRINCIPAL_KEY_ENCODED_BYTES + 1);
    const { bytesRead } = await handle.read(encodedBytes, 0, encodedBytes.length, 0);
    if (bytesRead !== PRINCIPAL_KEY_ENCODED_BYTES) {
      throw new Error("Offline package principal key has an invalid size");
    }
    const encoded = encodedBytes.subarray(0, bytesRead).toString("ascii");
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
      throw new Error("Offline package principal key is not canonical base64url");
    }
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.byteLength !== 32 || decoded.toString("base64url") !== encoded) {
      throw new Error("Offline package principal key is not canonical 32-byte base64url");
    }
    return decoded;
  } finally {
    await handle.close();
  }
}

export function deriveOfflinePackagePrincipal(userId: string, key: Buffer): string {
  if (!userId) throw new Error("Offline package principal requires an authenticated user");
  if (key.byteLength < 32) throw new Error("Offline package principal key is too short");
  return createHmac("sha256", key).update(userId, "utf8").digest("hex");
}

export interface OfflinePackagePrepareRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface RedisEval {
  eval(script: string, numberOfKeys: number, key: string, ...args: string[]): Promise<unknown>;
}

// Redis TIME is authoritative across API processes. Removal is inclusive so
// an event exactly ten minutes old no longer occupies the rolling window.
const ROLLING_LIMIT_SCRIPT = `
local nowParts = redis.call("TIME")
local nowMs = (tonumber(nowParts[1]) * 1000) + math.floor(tonumber(nowParts[2]) / 1000)
local windowMs = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", nowMs - windowMs)
local count = redis.call("ZCARD", KEYS[1])
if count >= maximum then
  local oldest = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
  local retryMs = math.max(1, tonumber(oldest[2]) + windowMs - nowMs)
  redis.call("PEXPIRE", KEYS[1], windowMs)
  return {0, math.ceil(retryMs / 1000)}
end
redis.call("ZADD", KEYS[1], nowMs, ARGV[3])
redis.call("PEXPIRE", KEYS[1], windowMs)
return {1, 0}
`;

function rateLimitTuple(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const allowed = Number(value[0]);
  const retry = Number(value[1]);
  if (
    (allowed !== 0 && allowed !== 1) ||
    !Number.isSafeInteger(retry) ||
    retry < 0 ||
    retry > Math.ceil(PREPARE_WINDOW_MS / 1_000)
  ) {
    return undefined;
  }
  return [allowed, retry];
}

export class OfflinePackagePrepareRateLimiter {
  constructor(private readonly redis: RedisEval) {}

  async consume(
    principal: string,
    operationId: string = randomUUID(),
  ): Promise<OfflinePackagePrepareRateLimitResult> {
    if (!PRINCIPAL_PATTERN.test(principal)) throw new Error("Invalid offline package principal");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
      throw new Error("Invalid offline package rate-limit operation id");
    }
    try {
      const raw = await this.redis.eval(
        ROLLING_LIMIT_SCRIPT,
        1,
        `offline-package:prepare:${principal}`,
        String(PREPARE_WINDOW_MS),
        String(PREPARE_MAX),
        operationId,
      );
      const tuple = rateLimitTuple(raw);
      if (!tuple) throw new Error("invalid Redis reply");
      return { allowed: tuple[0] === 1, retryAfterSeconds: tuple[1] };
    } catch {
      throw new Error("Offline package preparation quota is temporarily unavailable");
    }
  }
}

export const OFFLINE_PACKAGE_PREPARE_LIMIT = PREPARE_MAX;
export const OFFLINE_PACKAGE_PREPARE_WINDOW_MS = PREPARE_WINDOW_MS;
