import { describe, expect, it } from "vitest";
import {
  evaluatePlanetAcceptance,
  type PlanetBenchmarkRun,
} from "../../src/jobs/transitous/planet-acceptance.js";

const slo = {
  maximumBuildDurationMs: 24 * 60 * 60 * 1000,
  maximumQueryP95Ms: 1_500,
  maximumRollbackDurationMs: 5 * 60 * 1000,
  maximumFailedFeedPercent: 2,
  minimumDiskHeadroomPercent: 20,
};

function run(id: string, rollback = false): PlanetBenchmarkRun {
  return {
    id,
    inputClass: "planet",
    pinsHash: "pins",
    host: { cpu: "test", cores: 16, memoryGb: 128, disk: "nvme" },
    startedAt: "2026-07-15T00:00:00Z",
    finishedAt: "2026-07-15T01:00:00Z",
    downloadBytes: 1,
    buildDurationMs: 60 * 60 * 1000,
    peakRssBytes: 1,
    peakCpuPercent: 800,
    temporaryDiskBytes: 1,
    finalDiskBytes: 1,
    providerCount: 1,
    firstQueryMs: 100,
    queryP95Ms: 500,
    probeDurationMs: 100,
    rollbackDurationMs: rollback ? 30_000 : undefined,
    forcedRollbackPassed: rollback || undefined,
    failedFeedPercent: 0,
    finalDiskHeadroomPercent: 40,
  };
}

describe("planet acceptance gate", () => {
  it("stays experimental without two consecutive builds and a rollback", () => {
    expect(evaluatePlanetAcceptance([run("one")], slo)).toMatchObject({
      productionReady: false,
    });
  });

  it("accepts only two consecutive SLO builds plus a forced rollback", () => {
    expect(evaluatePlanetAcceptance([run("one"), run("two", true)], slo)).toEqual({
      productionReady: true,
      blockers: [],
      acceptedBuildIds: ["one", "two"],
    });
  });

  it("rejects a recent build that misses query SLO", () => {
    const failing = { ...run("two", true), queryP95Ms: 2_000 };
    expect(evaluatePlanetAcceptance([run("one"), failing], slo).productionReady).toBe(false);
  });
});
