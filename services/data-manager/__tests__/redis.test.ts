import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDataManagerRedisClient, createRedisClient } from "../src/redis";

const dirs: string[] = [];

function canonicalPassword(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-data-manager-redis-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("data-manager Redis password file", () => {
  it("uses the data-manager retry policy", async () => {
    const path = join(tempDir(), "password");
    const password = canonicalPassword(9);
    writeFileSync(path, password);

    const client = await createRedisClient({ url: "redis://redis:6379", passwordFile: path });
    expect(client.options.password).toBe(password);
    expect(client.options.host).toBe("redis");
    expect(client.options.port).toBe(6379);
    expect(client.options.lazyConnect).toBe(true);
    expect(client.options.maxRetriesPerRequest).toBe(3);
    client.disconnect();
  });

  it("fails startup unless both Redis URL and password file are explicitly configured", async () => {
    await expect(createDataManagerRedisClient({})).rejects.toThrow(
      "REDIS_URL and REDIS_PASSWORD_FILE are required",
    );
    await expect(createDataManagerRedisClient({ REDIS_URL: "redis://redis:6379" })).rejects.toThrow(
      "REDIS_URL and REDIS_PASSWORD_FILE are required",
    );
  });
});
