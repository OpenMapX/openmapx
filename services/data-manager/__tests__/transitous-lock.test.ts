import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseRefShaPair,
  readTransitousLock,
  readTransitousLockProposal,
  TRANSITOUS_LOCK_RELATIVE_PATH,
  TRANSITOUS_PROPOSED_LOCK_RELATIVE_PATH,
  type TransitousLock,
  writeTransitousLock,
  writeTransitousLockProposal,
} from "../src/transitous-lock.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function makeRepoRoot(): string {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-tlock-"));
  mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
  return tmp;
}

describe("parseRefShaPair", () => {
  it("splits a valid <branch>@<sha> ref", () => {
    const result = parseRefShaPair("main@099af198526dc192dd294a100ca4db29477e9133");
    expect(result).toEqual({
      branch: "main",
      sha: "099af198526dc192dd294a100ca4db29477e9133",
    });
  });

  it("rejects a ref without an @ separator", () => {
    expect(() => parseRefShaPair("main")).toThrow(/expected/);
  });

  it("rejects a ref with a non-hex SHA", () => {
    expect(() => parseRefShaPair("main@zzz")).toThrow(/hex/);
  });
});

describe("readTransitousLock / writeTransitousLock", () => {
  it("returns null when the file is absent", () => {
    const root = makeRepoRoot();
    expect(readTransitousLock(root)).toBeNull();
  });

  it("roundtrips a lockfile through write + read", () => {
    const root = makeRepoRoot();
    const lock: TransitousLock = {
      ref: "main@099af198526dc192dd294a100ca4db29477e9133",
      submodules: {
        "transitland-atlas": "4a8495c498107b7281d4a7e0611b84ffba313112",
      },
      lockedAt: "2026-05-22T00:00:00Z",
      lockedBy: "dev@example.test",
      comment: "test fixture",
    };
    writeTransitousLock(root, lock);
    const loaded = readTransitousLock(root);
    expect(loaded).toEqual(lock);
    const onDisk = JSON.parse(
      readFileSync(join(root, TRANSITOUS_LOCK_RELATIVE_PATH), "utf-8"),
    ) as Record<string, unknown>;
    expect(onDisk.$schema).toBe("./transitous.lock.schema.json");
  });

  it("writes a proposal without mutating the active lock", () => {
    const root = makeRepoRoot();
    const active: TransitousLock = {
      ref: "main@099af198526dc192dd294a100ca4db29477e9133",
      submodules: {},
      lockedAt: "2026-05-22T00:00:00Z",
      lockedBy: "active@example.test",
    };
    const proposed: TransitousLock = {
      ...active,
      ref: "main@4a8495c498107b7281d4a7e0611b84ffba313112",
      lockedBy: "reviewer@example.test",
    };
    writeTransitousLock(root, active);
    writeTransitousLockProposal(root, proposed);
    expect(readTransitousLock(root)).toEqual(active);
    expect(readTransitousLockProposal(root)).toEqual(proposed);
    expect(readFileSync(join(root, TRANSITOUS_PROPOSED_LOCK_RELATIVE_PATH), "utf-8")).toContain(
      proposed.ref,
    );
  });

  it("throws on a malformed lockfile", () => {
    const root = makeRepoRoot();
    writeFileSync(join(root, TRANSITOUS_LOCK_RELATIVE_PATH), "not json");
    expect(() => readTransitousLock(root)).toThrow(/parse/);
  });

  it("throws when required fields are missing", () => {
    const root = makeRepoRoot();
    writeFileSync(join(root, TRANSITOUS_LOCK_RELATIVE_PATH), JSON.stringify({ submodules: {} }));
    expect(() => readTransitousLock(root)).toThrow(/"ref"/);
  });
});
