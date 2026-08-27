import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDataManagerRedisClient,
  createRedisClient,
  readRedisPasswordFile,
} from "../src/redis";

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
  it("passes an exact canonical password separately from the connection URL", async () => {
    const path = join(tempDir(), "password");
    const password = canonicalPassword(9);
    writeFileSync(path, password);

    const client = await createRedisClient({ url: "redis://redis:6379", passwordFile: path });
    expect(client.options.password).toBe(password);
    expect(client.options.host).toBe("redis");
    expect(client.options.port).toBe(6379);
    client.disconnect();
  });

  it("rejects missing and empty files with redacted errors", async () => {
    const dir = tempDir();
    const missing = join(dir, "missing-test-only-sentinel");
    await expect(readRedisPasswordFile(missing)).rejects.toThrow(
      "Redis password file is missing or unreadable",
    );
    await expect(readRedisPasswordFile(missing)).rejects.not.toThrow(/missing-test-only-sentinel/);

    const empty = join(dir, "empty");
    writeFileSync(empty, "");
    await expect(readRedisPasswordFile(empty)).rejects.toThrow("Redis password file is empty");
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

  it("rejects oversized and non-regular sources without exposing file contents", async () => {
    const dir = tempDir();
    const oversized = join(dir, "oversized");
    const sentinel = "oversized-data-manager-test-only-sentinel";
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

  it("fails startup unless both Redis URL and password file are explicitly configured", async () => {
    await expect(createDataManagerRedisClient({})).rejects.toThrow(
      "REDIS_URL and REDIS_PASSWORD_FILE are required",
    );
    await expect(createDataManagerRedisClient({ REDIS_URL: "redis://redis:6379" })).rejects.toThrow(
      "REDIS_URL and REDIS_PASSWORD_FILE are required",
    );
  });
});
