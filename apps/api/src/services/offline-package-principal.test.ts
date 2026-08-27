import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveOfflinePackagePrincipal,
  OfflinePackagePrepareRateLimiter,
  readOfflinePackagePrincipalKeyFile,
} from "./offline-package-principal.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("offline-package principal secret", () => {
  it("loads only a canonical descriptor-safe 32-byte key and derives a stable opaque principal", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-offline-principal-"));
    roots.push(root);
    const path = join(root, "offline-package-principal-key");
    const encoded = Buffer.alloc(32, 7).toString("base64url");
    writeFileSync(path, encoded, { mode: 0o444 });

    const key = await readOfflinePackagePrincipalKeyFile(path);
    const principal = deriveOfflinePackagePrincipal("database-user-id", key);

    expect(key).toEqual(Buffer.alloc(32, 7));
    expect(principal).toMatch(/^[a-f0-9]{64}$/);
    expect(principal).not.toContain("database-user-id");
    expect(deriveOfflinePackagePrincipal("database-user-id", key)).toBe(principal);
  });

  it("fails closed for newline, weak, oversized, permissive, and symlink secrets without leaking bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-offline-principal-"));
    roots.push(root);
    const valid = Buffer.alloc(32, 11).toString("base64url");
    const cases = [
      ["newline", `${valid}\n`, 0o444],
      ["weak", Buffer.alloc(31, 11).toString("base64url"), 0o444],
      ["oversized", "x".repeat(4097), 0o444],
      ["permissive", valid, 0o644],
    ] as const;
    for (const [name, contents, mode] of cases) {
      const path = join(root, name);
      writeFileSync(path, contents, { mode });
      chmodSync(path, mode);
      await expect(readOfflinePackagePrincipalKeyFile(path)).rejects.toThrow();
      await expect(readOfflinePackagePrincipalKeyFile(path)).rejects.not.toThrow(
        contents.slice(0, 8),
      );
    }
    const target = join(root, "target");
    writeFileSync(target, valid, { mode: 0o444 });
    symlinkSync(target, join(root, "link"));
    await expect(readOfflinePackagePrincipalKeyFile(join(root, "link"))).rejects.toThrow(
      /regular/i,
    );
  });
});

describe("distributed rolling prepare limit", () => {
  it("consumes every call and permits exactly two timestamps in any rolling ten minutes", async () => {
    const evalsha = vi
      .fn()
      .mockResolvedValueOnce([1, 0])
      .mockResolvedValueOnce([1, 0])
      .mockResolvedValueOnce([0, 600])
      .mockResolvedValueOnce([1, 0]);
    const limiter = new OfflinePackagePrepareRateLimiter({ eval: evalsha });
    const principal = "a".repeat(64);

    await expect(limiter.consume(principal, "request-1")).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    await expect(limiter.consume(principal, "request-2")).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    await expect(limiter.consume(principal, "duplicate-request")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 600,
    });
    await expect(limiter.consume(principal, "after-boundary")).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });

    expect(evalsha).toHaveBeenCalledTimes(4);
    expect(
      evalsha.mock.calls.every((call) => call[2] === `offline-package:prepare:${principal}`),
    ).toBe(true);
    expect(JSON.stringify(evalsha.mock.calls)).not.toContain("database-user-id");
  });

  it("rejects malformed principals and fails closed when Redis is unavailable", async () => {
    const redis = { eval: vi.fn().mockRejectedValue(new Error("redis unavailable")) };
    const limiter = new OfflinePackagePrepareRateLimiter(redis);
    await expect(limiter.consume("not-a-principal", "request")).rejects.toThrow(/principal/i);
    await expect(limiter.consume("b".repeat(64), "request")).rejects.toThrow(
      /temporarily unavailable/i,
    );

    const invalidRetry = new OfflinePackagePrepareRateLimiter({
      eval: vi.fn().mockResolvedValue([0, 601]),
    });
    await expect(invalidRetry.consume("b".repeat(64), "request")).rejects.toThrow(
      /temporarily unavailable/i,
    );
  });
});
