import { existsSync, readdirSync } from "node:fs";
import type { StageFn, StageResult } from "./types.js";

const DEFAULT_STAGING_URL = "http://localhost:8082";
const PROBE_TIMEOUT_MS = 5_000;
const TOTAL_BUDGET_MS = 30_000;

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

interface ProbeFailure {
  probe: string;
  reason: string;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runProbe(
  name: string,
  url: string,
  init?: RequestInit,
): Promise<ProbeFailure | null> {
  try {
    const res = await fetchWithTimeout(url, { ...init, timeoutMs: PROBE_TIMEOUT_MS });
    if (!res.ok) {
      return { probe: name, reason: `HTTP ${res.status}` };
    }
    // Validate the response is JSON so we catch HTML error pages from a reverse
    // proxy that still returns 200.
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("json")) {
      return { probe: name, reason: `unexpected content-type ${ct || "(none)"}` };
    }
    await res.json();
    return null;
  } catch (error) {
    return { probe: name, reason: (error as Error).message };
  }
}

/**
 * Three probes against the staging MOTIS instance (port 8082 by default).
 * Fails fast on the first probe error; budgets the whole sequence under
 * {@link TOTAL_BUDGET_MS} so a hung MOTIS doesn't stall the pipeline.
 *
 *   1. `/api/v1/initial` — returns the bounded map view; smoke-tests that the
 *      server is up and the JSON pipe is intact.
 *   2. `/api/v1/stops` — small bbox query; confirms the timetable index loaded.
 *   3. `/api/v1/plan` — single-leg routing between two coordinates; covers the
 *      routing engine itself.
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

  const probe = {
    bboxMinLat: parseFloatEnv("MOTIS_HEALTH_BBOX_MIN_LAT", DEFAULT_PROBE.bboxMinLat),
    bboxMinLng: parseFloatEnv("MOTIS_HEALTH_BBOX_MIN_LNG", DEFAULT_PROBE.bboxMinLng),
    bboxMaxLat: parseFloatEnv("MOTIS_HEALTH_BBOX_MAX_LAT", DEFAULT_PROBE.bboxMaxLat),
    bboxMaxLng: parseFloatEnv("MOTIS_HEALTH_BBOX_MAX_LNG", DEFAULT_PROBE.bboxMaxLng),
    planFromLat: parseFloatEnv("MOTIS_HEALTH_PLAN_FROM_LAT", DEFAULT_PROBE.planFromLat),
    planFromLng: parseFloatEnv("MOTIS_HEALTH_PLAN_FROM_LNG", DEFAULT_PROBE.planFromLng),
    planToLat: parseFloatEnv("MOTIS_HEALTH_PLAN_TO_LAT", DEFAULT_PROBE.planToLat),
    planToLng: parseFloatEnv("MOTIS_HEALTH_PLAN_TO_LNG", DEFAULT_PROBE.planToLng),
  };

  const deadline = Date.now() + TOTAL_BUDGET_MS;

  const initialUrl = `${base}/api/v1/initial`;
  const stopsUrl =
    `${base}/api/v1/stops` +
    `?min=${probe.bboxMinLat},${probe.bboxMinLng}` +
    `&max=${probe.bboxMaxLat},${probe.bboxMaxLng}`;
  const planUrl =
    `${base}/api/v1/plan` +
    `?fromPlace=${probe.planFromLat},${probe.planFromLng}` +
    `&toPlace=${probe.planToLat},${probe.planToLng}`;

  const probes: Array<{ name: string; url: string }> = [
    // MOTIS's dedicated health endpoint is the fast liveness gate; the
    // functional probes below additionally confirm the timetable index and
    // routing engine actually answer queries.
    { name: "health", url: `${base}/api/v1/health` },
    { name: "initial", url: initialUrl },
    { name: "stops", url: stopsUrl },
    { name: "plan", url: planUrl },
  ];

  for (const p of probes) {
    if (Date.now() > deadline) {
      return {
        stage: "motis-health",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `motis-health exceeded total budget ${TOTAL_BUDGET_MS}ms before reaching probe "${p.name}"`,
      } satisfies StageResult;
    }
    const failure = await runProbe(p.name, p.url);
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

  return {
    stage: "motis-health",
    status: "ok",
    startedAt,
    finishedAt: ctx.now(),
    durationMs: Date.now() - start,
    message: `motis-health: ${probes.length} probes passed against ${base}`,
    artifacts: {
      probes: probes.map((p) => p.name),
      stagingUrl: base,
    },
  } satisfies StageResult;
};
