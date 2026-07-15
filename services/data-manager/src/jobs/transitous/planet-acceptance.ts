export interface PlanetBenchmarkRun {
  id: string;
  inputClass: "small-region" | "large-country" | "multi-continent" | "planet";
  pinsHash: string;
  host: { cpu: string; cores: number; memoryGb: number; disk: string };
  startedAt: string;
  finishedAt: string;
  downloadBytes: number;
  buildDurationMs: number;
  peakRssBytes: number;
  peakCpuPercent: number;
  temporaryDiskBytes: number;
  finalDiskBytes: number;
  providerCount: number;
  firstQueryMs: number;
  queryP95Ms: number;
  probeDurationMs: number;
  rollbackDurationMs?: number;
  forcedRollbackPassed?: boolean;
  failedFeedPercent: number;
  finalDiskHeadroomPercent: number;
}

export interface PlanetSlo {
  maximumBuildDurationMs: number;
  maximumQueryP95Ms: number;
  maximumRollbackDurationMs: number;
  maximumFailedFeedPercent: number;
  minimumDiskHeadroomPercent: number;
}

export interface PlanetAcceptanceResult {
  productionReady: boolean;
  blockers: string[];
  acceptedBuildIds: string[];
}

export function evaluatePlanetAcceptance(
  runs: PlanetBenchmarkRun[],
  slo: PlanetSlo,
): PlanetAcceptanceResult {
  const complete = runs.filter((run) => run.inputClass === "planet");
  const accepted = complete.filter(
    (run) =>
      run.buildDurationMs <= slo.maximumBuildDurationMs &&
      run.queryP95Ms <= slo.maximumQueryP95Ms &&
      run.failedFeedPercent <= slo.maximumFailedFeedPercent &&
      run.finalDiskHeadroomPercent >= slo.minimumDiskHeadroomPercent,
  );
  const rollback = complete.find(
    (run) =>
      run.forcedRollbackPassed === true &&
      run.rollbackDurationMs !== undefined &&
      run.rollbackDurationMs <= slo.maximumRollbackDurationMs,
  );
  const blockers: string[] = [];
  if (accepted.length < 2) blockers.push("two consecutive accepted planet builds are required");
  else {
    const lastTwo = complete.slice(-2);
    if (!lastTwo.every((run) => accepted.includes(run))) {
      blockers.push("the two most recent planet builds must both meet SLOs");
    }
  }
  if (!rollback) blockers.push("one forced rollback must meet the rollback SLO");
  return {
    productionReady: blockers.length === 0,
    blockers,
    acceptedBuildIds: accepted.map((run) => run.id),
  };
}
