import {
  createSecretBackedRedisClient,
  type RedisSecretOptions,
} from "@openmapx/core/redis-secret";
import Redis from "ioredis";

export async function createRedisClient(options: RedisSecretOptions): Promise<Redis> {
  return createSecretBackedRedisClient(
    options,
    { enableOfflineQueue: false },
    (url, clientOptions) => new Redis(url, clientOptions),
  );
}

const url = process.env.REDIS_URL?.trim();
const passwordFile = process.env.REDIS_PASSWORD_FILE?.trim();

if (url && !passwordFile) {
  throw new Error("REDIS_PASSWORD_FILE is required when REDIS_URL is configured");
}

export const redis = url && passwordFile ? await createRedisClient({ url, passwordFile }) : null;
