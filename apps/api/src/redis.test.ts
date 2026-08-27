import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRedisClient, readRedisPasswordFile } from "./redis";

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
  it("passes an exact canonical password separately from the URL", async () => {
    const path = join(tempDir(), "password");
    const password = canonicalPassword(7);
    writeFileSync(path, password);

    const client = await createRedisClient({ url: "redis://redis:6379", passwordFile: path });
    expect(client.options.password).toBe(password);
    expect(client.options.host).toBe("redis");
    expect(client.options.port).toBe(6379);
    client.disconnect();
  });

  it("rejects a missing password file with a redacted error", async () => {
    const path = join(tempDir(), "missing-test-only-sentinel");
    await expect(readRedisPasswordFile(path)).rejects.toThrow(
      "Redis password file is missing or unreadable",
    );
    await expect(readRedisPasswordFile(path)).rejects.not.toThrow(/missing-test-only-sentinel/);
  });

  it("rejects an empty password file", async () => {
    const path = join(tempDir(), "password");
    writeFileSync(path, "");
    await expect(readRedisPasswordFile(path)).rejects.toThrow("Redis password file is empty");
  });

  it.each([
    `${canonicalPassword(1)}\n`,
    ` ${canonicalPassword(1)}`,
    `${canonicalPassword(1)}\0`,
    canonicalPassword(1).slice(0, -1),
    "a".repeat(43),
  ])("rejects a noncanonical password without trimming it", async (value) => {
    const path = join(tempDir(), "password");
    writeFileSync(path, value);
    await expect(readRedisPasswordFile(path)).rejects.toThrow(/canonical/);
    await expect(readRedisPasswordFile(path)).rejects.not.toThrow(new RegExp(value.slice(0, 8)));
  });

  it("rejects oversized and non-regular password sources without exposing contents", async () => {
    const dir = tempDir();
    const oversized = join(dir, "oversized");
    const sentinel = "oversized-test-only-sentinel";
    writeFileSync(oversized, sentinel.repeat(200));
    await expect(readRedisPasswordFile(oversized)).rejects.toThrow(
      "Redis password file exceeds the size limit",
    );
    await expect(readRedisPasswordFile(oversized)).rejects.not.toThrow(new RegExp(sentinel));

    const link = join(dir, "password-link");
    symlinkSync(oversized, link);
    await expect(readRedisPasswordFile(link)).rejects.toThrow(
      "Redis password file must be a regular file",
    );
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
