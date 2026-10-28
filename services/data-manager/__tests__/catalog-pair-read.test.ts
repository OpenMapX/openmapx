import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readTransitousLock } from "../src/transitous-lock.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
it("never treats one legacy Transitous file as an authoritative complete catalog pair", () => {
  const root = mkdtempSync(join(tmpdir(), "omx-pins-read-"));
  roots.push(root);
  mkdirSync(join(root, "infra/docker"), { recursive: true });
  writeFileSync(
    join(root, "infra/docker/transitous.lock.json"),
    JSON.stringify({
      ref: `main@${"a".repeat(40)}`,
      submodules: {},
      lockedAt: "2026-10-23T00:00:00.000Z",
      lockedBy: "fixture",
    }),
  );
  expect(() => readTransitousLock(root)).toThrow(/paired|initializ|catalog/i);
});
