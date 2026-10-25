import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diffFeedFiles,
  transitousPinIsCurrent,
  writeTransitousLockProposal,
} from "../src/commands/transitous-bump.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

const TRANSITOUS = {
  ref: `main@${"a".repeat(40)}`,
  submodules: { "transitland-atlas": "b".repeat(40) },
  lockedAt: "2026-07-15T00:00:00.000Z",
  lockedBy: "test",
};

describe("Transitous catalog bump", () => {
  it("detects a no-op only when the Transitous pin matches", () => {
    expect(transitousPinIsCurrent(TRANSITOUS, "a".repeat(40))).toBe(true);
    expect(transitousPinIsCurrent(TRANSITOUS, "f".repeat(40))).toBe(false);
    expect(transitousPinIsCurrent(null, "a".repeat(40))).toBe(false);
  });

  it("reports removed feeds and license changes for compatibility review", () => {
    const summary = diffFeedFiles(
      new Map([
        [
          "de",
          {
            sources: [
              { name: "BVG", license: { "spdx-identifier": "CC-BY-4.0" } },
              { name: "Removed" },
            ],
          },
        ],
      ]),
      new Map([["de", { sources: [{ name: "BVG", license: { "spdx-identifier": "ODbL-1.0" } }] }]]),
    );
    expect(summary.removedSources).toBe(1);
    expect(summary.licenseChanges).toEqual([{ region: "de", source: "BVG" }]);
  });

  it("writes a proposal and never a pin the repository tracks", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "openmapx-bump-proposal-"));
    const directory = join(temporaryRoot, "infra", "docker");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "transitous.lock.json"), "active-transitous\n");
    writeFileSync(join(directory, "gbfs-catalog.lock.json"), "release-gbfs\n");
    writeTransitousLockProposal(temporaryRoot, TRANSITOUS);
    expect(readFileSync(join(directory, "transitous.lock.json"), "utf-8")).toBe(
      "active-transitous\n",
    );
    expect(readFileSync(join(directory, "gbfs-catalog.lock.json"), "utf-8")).toBe("release-gbfs\n");
    expect(readFileSync(join(directory, "transitous.lock.proposed.json"), "utf-8")).toContain(
      TRANSITOUS.ref,
    );
    expect(existsSync(join(directory, "gbfs-catalog.lock.proposed.json"))).toBe(false);
  });
});
