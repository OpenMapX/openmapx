import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretBackedRedisClient, readRedisPasswordFile } from "./redis-secret";

const directories: string[] = [];

function canonicalPassword(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-redis-secret-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Redis password files", () => {
  it("passes an exact canonical password to the client factory", async () => {
    const passwordFile = join(tempDir(), "password");
    const password = canonicalPassword(7);
    writeFileSync(passwordFile, password);
    const createClient = vi.fn().mockReturnValue({ connected: false });

    await expect(
      createSecretBackedRedisClient(
        { url: "redis://redis:6379", passwordFile },
        { enableOfflineQueue: false },
        createClient,
      ),
    ).resolves.toEqual({ connected: false });
    expect(createClient).toHaveBeenCalledWith("redis://redis:6379", {
      password,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
  });

  it("rejects missing and empty files with redacted errors", async () => {
    const directory = tempDir();
    const missing = join(directory, "missing-test-only-sentinel");
    await expect(readRedisPasswordFile(missing)).rejects.toThrow(
      "Redis password file is missing or unreadable",
    );
    await expect(readRedisPasswordFile(missing)).rejects.not.toThrow(/missing-test-only-sentinel/);

    const empty = join(directory, "empty");
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
    const passwordFile = join(tempDir(), "password");
    writeFileSync(passwordFile, value);
    await expect(readRedisPasswordFile(passwordFile)).rejects.toThrow(/canonical/);
    await expect(readRedisPasswordFile(passwordFile)).rejects.not.toThrow(
      new RegExp(value.slice(0, 8)),
    );
  });

  it("rejects oversized and non-regular sources without exposing their contents", async () => {
    const directory = tempDir();
    const oversized = join(directory, "oversized");
    const sentinel = "oversized-test-only-sentinel";
    writeFileSync(oversized, sentinel.repeat(200));
    await expect(readRedisPasswordFile(oversized)).rejects.toThrow(
      "Redis password file exceeds the size limit",
    );
    await expect(readRedisPasswordFile(oversized)).rejects.not.toThrow(new RegExp(sentinel));

    const link = join(directory, "password-link");
    symlinkSync(oversized, link);
    await expect(readRedisPasswordFile(link)).rejects.toThrow(
      "Redis password file must be a regular file",
    );

    const nestedDirectory = join(directory, "nested");
    mkdirSync(nestedDirectory);
    await expect(readRedisPasswordFile(nestedDirectory)).rejects.toThrow(
      "Redis password file must be a regular file",
    );
  });
});
