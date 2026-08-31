import {
  createSecretBackedRedisClient,
  type RedisSecretOptions,
} from "@openmapx/core/redis-secret";
import Redis from "ioredis";

export async function createRedisClient(options: RedisSecretOptions): Promise<Redis> {
  return createSecretBackedRedisClient(
    options,
    { maxRetriesPerRequest: 3 },
    (url, clientOptions) => new Redis(url, clientOptions),
  );
}

export async function createDataManagerRedisClient(
  env: Record<string, string | undefined> = process.env,
): Promise<Redis> {
  const url = env.REDIS_URL?.trim();
  const passwordFile = env.REDIS_PASSWORD_FILE?.trim();
  if (!url || !passwordFile) {
    throw new Error("REDIS_URL and REDIS_PASSWORD_FILE are required for data-manager startup");
  }
  return createRedisClient({ url, passwordFile });
}
