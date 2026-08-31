import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRedisClient } from "./redis";

const dirs: string[] = [];

function canonicalPassword(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-api-redis-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Redis password file", () => {
  it("disables the offline queue for the API client", async () => {
    const path = join(tempDir(), "password");
    const password = canonicalPassword(7);
    writeFileSync(path, password);

    const client = await createRedisClient({ url: "redis://redis:6379", passwordFile: path });
    expect(client.options.password).toBe(password);
    expect(client.options.host).toBe("redis");
    expect(client.options.port).toBe(6379);
    expect(client.options.lazyConnect).toBe(true);
    expect(client.options.enableOfflineQueue).toBe(false);
    client.disconnect();
  });

  it("fails module startup when REDIS_URL is configured without a password file", async () => {
    const originalUrl = process.env.REDIS_URL;
    const originalPasswordFile = process.env.REDIS_PASSWORD_FILE;
    process.env.REDIS_URL = "redis://redis:6379";
    delete process.env.REDIS_PASSWORD_FILE;
    vi.resetModules();

    try {
      await expect(import("./redis")).rejects.toThrow(
        "REDIS_PASSWORD_FILE is required when REDIS_URL is configured",
      );
    } finally {
      if (originalUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = originalUrl;
      if (originalPasswordFile === undefined) delete process.env.REDIS_PASSWORD_FILE;
      else process.env.REDIS_PASSWORD_FILE = originalPasswordFile;
      vi.resetModules();
    }
  });
});
