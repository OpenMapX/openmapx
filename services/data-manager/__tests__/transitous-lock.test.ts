import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTransitousLock,
  TRANSITOUS_LOCK_RELATIVE_PATH,
  type TransitousLock,
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

describe("readTransitousLock", () => {
  it("returns null when the file is absent", () => {
    const root = makeRepoRoot();
    expect(readTransitousLock(root)).toBeNull();
  });

  it("reads the pin the repository tracks", () => {
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
    writeFileSync(
      join(root, TRANSITOUS_LOCK_RELATIVE_PATH),
      JSON.stringify({ $schema: "./transitous.lock.schema.json", ...lock }),
    );
    expect(readTransitousLock(root)).toEqual(lock);
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
