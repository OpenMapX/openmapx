import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareOvertureReleases,
  overtureReleaseRetentionFromEnv,
  pruneOvertureReleases,
} from "../../src/jobs/overture/retention.js";

describe("Overture release retention", () => {
  it("orders multi-digit revisions numerically", () => {
    expect(compareOvertureReleases("2026-07-22.10", "2026-07-22.9")).toBeGreaterThan(0);
    expect(compareOvertureReleases("2026-08-01.0", "2026-07-22.99")).toBeGreaterThan(0);
  });

  it("keeps the active release and one predecessor without touching work directories", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-overture-retention-"));
    const root = join(dataDir, "overture");
    for (const release of ["2026-05-20.0", "2026-06-18.0", "2026-07-22.0"]) {
      mkdirSync(join(root, release), { recursive: true });
      writeFileSync(join(root, release, "germany.parquet"), release);
    }
    mkdirSync(join(root, "osm-extract"));

    const result = pruneOvertureReleases({
      dataDir,
      activeRelease: "2026-07-22.0",
      retain: 2,
    });

    expect(result).toEqual({
      retained: ["2026-07-22.0", "2026-06-18.0"],
      removed: ["2026-05-20.0"],
    });
    expect(readdirSync(root).sort()).toEqual(["2026-06-18.0", "2026-07-22.0", "osm-extract"]);
  });

  it("validates the environment retention bound", () => {
    expect(overtureReleaseRetentionFromEnv(undefined)).toBe(2);
    expect(overtureReleaseRetentionFromEnv("3")).toBe(3);
    expect(() => overtureReleaseRetentionFromEnv("0")).toThrow(/between 1 and 12/);
    expect(() => overtureReleaseRetentionFromEnv("many")).toThrow(/between 1 and 12/);
  });

  it("does not delete a newer pulled snapshot when an older release is pinned active", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-overture-retention-pinned-"));
    const root = join(dataDir, "overture");
    for (const release of ["2026-05-20.0", "2026-06-18.0", "2026-07-22.0"]) {
      mkdirSync(join(root, release), { recursive: true });
    }
    const result = pruneOvertureReleases({
      dataDir,
      activeRelease: "2026-06-18.0",
      retain: 1,
    });
    expect(result.retained).toEqual(["2026-07-22.0", "2026-06-18.0"]);
    expect(result.removed).toEqual(["2026-05-20.0"]);
  });
});
