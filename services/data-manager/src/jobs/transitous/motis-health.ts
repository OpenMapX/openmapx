import { existsSync, readdirSync } from "node:fs";
import { healthUrl, mapInitialUrl, mapStopsUrl, planUrl } from "./motis-endpoints.js";
import { parseIntEnv, pollUntilHealthy, probe } from "./motis-probe.js";
import type { StageFn, StageResult } from "./types.js";

const DEFAULT_STAGING_URL = "http://localhost:8082";
const PROBE_TIMEOUT_MS = 5_000;
// How long to wait for the staging MOTIS to finish importing and bind its
// server. A full regional import (e.g. Germany with street routing) takes many
// minutes; the canary's tiny feeds finish in seconds. Override per region/host
// with MOTIS_IMPORT_TIMEOUT_MS — too short a budget makes motis-health time out
// mid-import and the pipeline never reaches a healthy staging to promote.
const DEFAULT_IMPORT_TIMEOUT_MS = 30 * 60_000;
// Budget for the functional probes once the server is already up (answers fast).
const FUNCTIONAL_BUDGET_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 2_000;

// Berlin Hauptbahnhof-ish (52.525, 13.369) and Munich Hauptbahnhof (48.140, 11.558)
// — large German station references that the planet-scale Transitous import
// always contains. For other regions the operator-supplied `MOTIS_HEALTH_*`
// env vars override these.
const DEFAULT_PROBE = {
  bboxMinLat: 52.515,
  bboxMinLng: 13.359,
  bboxMaxLat: 52.535,
  bboxMaxLng: 13.379,
  planFromLat: 52.525,
  planFromLng: 13.369,
  planToLat: 48.14,
  planToLng: 11.558,
};

function parseFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function stagingUrl(): string {
  return process.env.MOTIS_STAGING_URL ?? DEFAULT_STAGING_URL;
}

/**
 * Probes against the staging MOTIS instance (port 8082 by default). Polls the
 * liveness endpoint until the server is up, then runs the functional probes;
 * fails fast on the first error. The whole sequence is budgeted under
 * {@link TOTAL_BUDGET_MS} (each probe's timeout is clamped to the remaining
 * budget) so a hung MOTIS doesn't stall the pipeline.
 *
 *   1. `/api/v1/health` — liveness gate, polled until the server binds.
 *   2. `/api/v1/map/initial` — bounded map view; confirms the JSON pipe is intact.
 *   3. `/api/v1/map/stops` — small bbox query; confirms the timetable index loaded.
 *   4. `/api/v1/plan` — single-leg routing; covers the routing engine itself.
 *
 * The probe targets default to coordinates in Germany (the catalog's primary
 * coverage area). Operators outside that region override the defaults with
 * `MOTIS_HEALTH_BBOX_*` / `MOTIS_HEALTH_PLAN_*` env vars.
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();

  // Pre-flight: if the staging data dir wasn't populated by upstream stages
  // (typical for dev / unit tests / first-run with no feeds) there's nothing
  // to probe. Skip rather than error so the pipeline keeps running.
  if (!existsSync(ctx.motisStagingDataDir)) {
    return {
      stage: "motis-health",
      status: "skipped",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: `staging data dir ${ctx.motisStagingDataDir} does not exist`,
    } satisfies StageResult;
  }
  try {
    if (readdirSync(ctx.motisStagingDataDir).length === 0) {
      return {
        stage: "motis-health",
        status: "skipped",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `staging data dir ${ctx.motisStagingDataDir} is empty`,
      } satisfies StageResult;
    }
  } catch {
    // Unreadable — fall through to the probes, which will surface the real
    // failure mode.
  }

  const base = stagingUrl();

  const bbox = {
    minLat: parseFloatEnv("MOTIS_HEALTH_BBOX_MIN_LAT", DEFAULT_PROBE.bboxMinLat),
    minLng: parseFloatEnv("MOTIS_HEALTH_BBOX_MIN_LNG", DEFAULT_PROBE.bboxMinLng),
    maxLat: parseFloatEnv("MOTIS_HEALTH_BBOX_MAX_LAT", DEFAULT_PROBE.bboxMaxLat),
    maxLng: parseFloatEnv("MOTIS_HEALTH_BBOX_MAX_LNG", DEFAULT_PROBE.bboxMaxLng),
  };
  const plan = {
    fromLat: parseFloatEnv("MOTIS_HEALTH_PLAN_FROM_LAT", DEFAULT_PROBE.planFromLat),
    fromLng: parseFloatEnv("MOTIS_HEALTH_PLAN_FROM_LNG", DEFAULT_PROBE.planFromLng),
    toLat: parseFloatEnv("MOTIS_HEALTH_PLAN_TO_LAT", DEFAULT_PROBE.planToLat),
    toLng: parseFloatEnv("MOTIS_HEALTH_PLAN_TO_LNG", DEFAULT_PROBE.planToLng),
  };

  // Two budgets: a long one to wait out the staging import (the server only
  // binds once `motis import` finishes), then a short one for the functional
  // probes once it's up.
  const importTimeoutMs = parseIntEnv("MOTIS_IMPORT_TIMEOUT_MS", DEFAULT_IMPORT_TIMEOUT_MS);
  const importDeadline = Date.now() + importTimeoutMs;

  // MOTIS's dedicated health endpoint is the liveness gate — poll it until the
  // server is up (or the import budget runs out), then run the functional probes
  // that confirm the timetable index and routing engine answer queries.
  const healthFailure = await pollUntilHealthy(healthUrl(base), importDeadline, {
    intervalMs: HEALTH_POLL_INTERVAL_MS,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
  });
  if (healthFailure) {
    return {
      stage: "motis-health",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: `motis-health probe "${healthFailure.probe}" failed: ${healthFailure.reason}`,
      artifacts: { failedProbe: healthFailure.probe, url: healthUrl(base) },
    } satisfies StageResult;
  }

  const functionalProbes: Array<{ name: string; url: string }> = [
    { name: "initial", url: mapInitialUrl(base) },
    { name: "stops", url: mapStopsUrl(base, bbox) },
    { name: "plan", url: planUrl(base, plan) },
  ];

  const probeDeadline = Date.now() + FUNCTIONAL_BUDGET_MS;
  for (const p of functionalProbes) {
    const remaining = probeDeadline - Date.now();
    if (remaining <= 0) {
      return {
        stage: "motis-health",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `motis-health exceeded functional-probe budget ${FUNCTIONAL_BUDGET_MS}ms before reaching probe "${p.name}"`,
      } satisfies StageResult;
    }
    const failure = await probe(p.name, p.url, Math.min(PROBE_TIMEOUT_MS, remaining));
    if (failure) {
      return {
        stage: "motis-health",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `motis-health probe "${failure.probe}" failed: ${failure.reason}`,
        artifacts: { failedProbe: failure.probe, url: p.url },
      } satisfies StageResult;
    }
  }

  const probeNames = ["health", ...functionalProbes.map((p) => p.name)];
  return {
    stage: "motis-health",
    status: "ok",
    startedAt,
    finishedAt: ctx.now(),
    durationMs: Date.now() - start,
    message: `motis-health: ${probeNames.length} probes passed against ${base}`,
    artifacts: {
      probes: probeNames,
      stagingUrl: base,
    },
  } satisfies StageResult;
};
