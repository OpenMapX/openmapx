import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

const MAX_REDIS_PASSWORD_BYTES = 4_096;

export interface RedisSecretOptions {
  url: string;
  passwordFile: string;
}

interface RedisSecretClientOptions {
  password: string;
  lazyConnect: true;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isCanonicalRedisPassword(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

export async function readRedisPasswordFile(passwordFile: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(
      passwordFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new Error("Redis password file must be a regular file");
    }
    throw new Error("Redis password file is missing or unreadable");
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Redis password file must be a regular file");
    if (stats.size > MAX_REDIS_PASSWORD_BYTES) {
      throw new Error("Redis password file exceeds the size limit");
    }

    const bytes = Buffer.alloc(MAX_REDIS_PASSWORD_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_REDIS_PASSWORD_BYTES) {
      throw new Error("Redis password file exceeds the size limit");
    }
    if (bytesRead === 0) throw new Error("Redis password file is empty");

    const password = bytes.subarray(0, bytesRead).toString("utf8");
    if (!isCanonicalRedisPassword(password)) {
      throw new Error("Redis password file must contain canonical base64url-encoded 32-byte data");
    }
    return password;
  } finally {
    await handle.close();
  }
}

export async function createSecretBackedRedisClient<TClient, TOptions extends object>(
  secret: RedisSecretOptions,
  clientOptions: TOptions,
  createClient: (url: string, options: TOptions & RedisSecretClientOptions) => TClient,
): Promise<TClient> {
  const password = await readRedisPasswordFile(secret.passwordFile);
  return createClient(secret.url, {
    ...clientOptions,
    password,
    lazyConnect: true,
  });
}
