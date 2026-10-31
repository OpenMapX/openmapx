import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireStoreLock } from "../release-store-lock";

let root: string;
const lockName = ".test-release-lock";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-release-lock-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("release-store lock filesystem policy", () => {
  it("does not reclaim a live backup operation before its fixed 35-minute lease", async () => {
    const first = await acquireStoreLock(root, lockName, {}, () => 0, false, 35 * 60000);
    let reads = 0;
    const later = () => 20 * 60000 + (++reads > 2 ? 61000 : 0);
    try {
      await expect(acquireStoreLock(root, lockName, {}, later, false, 35 * 60000)).rejects.toThrow(
        /busy/,
      );
    } finally {
      first.release();
    }
  });
  it("publishes its owner, rejects a competing holder, and allows reuse after release", async () => {
    const first = await acquireStoreLock(root, lockName);
    const owner = JSON.parse(readFileSync(join(root, lockName, "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(typeof owner.nonce).toBe("string");
    expect(Number.isFinite(owner.acquiredAtMs)).toBe(true);
    await expect(acquireStoreLock(root, lockName, {}, Date.now, true)).rejects.toThrow(/busy/);
    first.release();
    expect(readdirSync(root)).toEqual([]);
    const second = await acquireStoreLock(root, lockName);
    try {
      expect(readdirSync(join(root, lockName))).toEqual(["owner.json"]);
    } finally {
      second.release();
    }
  });

  it("reads and reclaims an expired valid owner without changing lease policy", async () => {
    const directory = join(root, lockName);
    mkdirSync(directory);
    writeFileSync(join(directory, "owner.json"), JSON.stringify({ acquiredAtMs: 0 }));
    const lock = await acquireStoreLock(root, lockName, {}, () => 1_000_000);
    try {
      expect(JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")).acquiredAtMs).toBe(
        1_000_000,
      );
      expect(readdirSync(directory)).toEqual(["owner.json"]);
    } finally {
      lock.release();
    }
  });

  it("reads a live valid owner and reports contention at its acquisition deadline", async () => {
    const directory = join(root, lockName);
    mkdirSync(directory);
    const bytes = JSON.stringify({ acquiredAtMs: 0 });
    writeFileSync(join(directory, "owner.json"), bytes);
    let calls = 0;
    await expect(
      acquireStoreLock(root, lockName, {}, () => (calls++ === 0 ? 0 : 60_000)),
    ).rejects.toThrow(/busy/);
    expect(readFileSync(join(directory, "owner.json"), "utf8")).toBe(bytes);
  });

  it.each(["symlink", "hardlink", "directory", "oversize", "invalid UTF-8", "invalid JSON"])(
    "rejects an unsafe %s owner instead of reclaiming it",
    async (kind) => {
      const directory = join(root, lockName);
      mkdirSync(directory);
      const owner = join(directory, "owner.json");
      const target = join(root, "target");
      const contents = JSON.stringify({ acquiredAtMs: 0 });
      if (kind === "directory") mkdirSync(owner);
      else if (kind === "symlink" || kind === "hardlink") {
        writeFileSync(target, contents);
        if (kind === "symlink") symlinkSync(target, owner);
        else linkSync(target, owner);
      } else
        writeFileSync(
          owner,
          kind === "oversize"
            ? "x".repeat(4097)
            : kind === "invalid UTF-8"
              ? Buffer.from([0xff])
              : "{",
        );
      await expect(acquireStoreLock(root, lockName, {}, () => 1_000_000)).rejects.toThrow(
        /unreadable/,
      );
      expect(readdirSync(directory)).toEqual(["owner.json"]);
      if (kind === "symlink" || kind === "hardlink")
        expect(readFileSync(target, "utf8")).toBe(contents);
    },
  );
});
