import { existsSync, readdirSync } from "node:fs";
import { verifyCandidateManifest } from "./candidate.js";
import { runFunctionalProbes, writeCapabilitySnapshot } from "./functional-probes.js";
import { healthUrl } from "./motis-endpoints.js";
import { parseIntEnv, pollUntilHealthy } from "./motis-probe.js";
import type { StageFn, StageResult } from "./types.js";

const DEFAULT_STAGING_URL = "http://localhost:8082";
// 60 min: a route_shapes-augmented dataset is much larger, so staging MOTIS
// takes longer to load it before it answers health probes. Override with
// MOTIS_IMPORT_TIMEOUT_MS. The poll exits as soon as staging is healthy, so a
// fast (no-route_shapes) load still passes quickly — this only raises the ceiling.
const DEFAULT_IMPORT_TIMEOUT_MS = 60 * 60_000;
const FUNCTIONAL_BUDGET_MS = 60_000;

/** Poll staging liveness, then apply the exact same typed capability gate used after activation. */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  const finish = (
    status: StageResult["status"],
    message: string,
    artifacts?: Record<string, unknown>,
  ): StageResult => ({
    stage: "motis-health",
    status,
    startedAt,
    finishedAt: ctx.now(),
    durationMs: Date.now() - start,
    message,
    artifacts,
  });

  if (!existsSync(ctx.motisStagingDataDir) || readdirSync(ctx.motisStagingDataDir).length === 0) {
    return finish("skipped", `staging data dir ${ctx.motisStagingDataDir} is missing or empty`);
  }

  try {
    const manifest = verifyCandidateManifest(ctx.motisStagingDataDir);
    const baseUrl = process.env.MOTIS_STAGING_URL ?? DEFAULT_STAGING_URL;
    const importDeadline =
      Date.now() + parseIntEnv("MOTIS_IMPORT_TIMEOUT_MS", DEFAULT_IMPORT_TIMEOUT_MS);
    const liveness = await pollUntilHealthy(healthUrl(baseUrl), importDeadline, {
      intervalMs: 2_000,
    });
    if (liveness) {
      return finish("error", `motis-health probe "${liveness.probe}" failed: ${liveness.reason}`, {
        failedProbe: liveness.probe,
        candidateEpoch: manifest.epoch,
      });
    }

    // Re-verify after the long import wait: no candidate input may change once probing begins.
    verifyCandidateManifest(ctx.motisStagingDataDir);
    const report = await runFunctionalProbes(baseUrl, manifest, Date.now() + FUNCTIONAL_BUDGET_MS);
    if (!report.ok) {
      return finish(
        "error",
        `motis-health probe "${report.failure?.name}" failed: ${report.failure?.evidence}`,
        { candidateEpoch: manifest.epoch, probes: report.outcomes },
      );
    }
    const snapshot = writeCapabilitySnapshot(
      ctx.motisStagingDataDir,
      ctx.repoRoot,
      manifest,
      report,
      ctx.now(),
    );
    return finish("ok", `motis-health: ${report.outcomes.length} typed probes passed`, {
      candidateEpoch: manifest.epoch,
      configHash: manifest.artifacts.config.sha256,
      licenseHash: manifest.artifacts.license.sha256,
      probes: report.outcomes,
      capabilitySnapshot: snapshot,
      stagingUrl: baseUrl,
    });
  } catch (error) {
    return finish("error", (error as Error).message, {
      failure: (error as Error).message,
    });
  }
};
