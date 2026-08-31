import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  HealthResponse,
  InitialResponse,
  PlanResponse,
  RentalsResponse,
  StopsResponse,
} from "@motis-project/motis-client";
import { MOTIS_VERSION } from "@openmapx/transitous-core";
import { readTransitousLock } from "../../transitous-lock.js";
import { atomicWriteJsonSync } from "../../utils/atomic-write.js";
import { CAPABILITY_SNAPSHOT_FILENAME, type MotisCandidateManifest } from "./candidate.js";
import {
  elevationPlanUrl,
  healthUrl,
  mapInitialUrl,
  mapStopsUrl,
  oneToManyIntermodalUrl,
  planUrl,
  rentalPlanUrl,
  rentalsUrl,
  routedTransferPlanUrl,
} from "./motis-endpoints.js";
import { DEFAULT_PROBE_TIMEOUT_MS, fetchWithTimeout, parseIntEnv } from "./motis-probe.js";

type JsonRecord = Record<string, unknown>;

export interface ProbeOutcome {
  name: string;
  durationMs: number;
  url: string;
  ok: boolean;
  evidence?: string;
}

export interface ObservedRentalCapabilities {
  providerIds: string[];
  providerGroupIds: string[];
  formFactors: string[];
  returnConstraints: string[];
  providerBboxes: Record<string, [number, number, number, number]>;
}

export interface ObservedReachabilityCapabilities {
  motisVersion: string | null;
  hasStreetRouting: boolean;
  maxOneToManySize: number;
  maxOneToAllTravelTimeMinutes: number;
  maxPrePostTransitSeconds: number;
  maxDirectSeconds: number;
  oneToManyIntermodalVerified: boolean;
  canaryDurationMs: number | null;
}

export interface FunctionalProbeReport {
  ok: boolean;
  outcomes: ProbeOutcome[];
  health?: HealthResponse;
  rentals?: ObservedRentalCapabilities;
  planningFeatures: { hasRoutedTransfers: boolean; hasElevation: boolean };
  reachability: ObservedReachabilityCapabilities;
  failure?: ProbeOutcome;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeHealth(value: unknown, expectsGbfs: boolean): HealthResponse {
  if (!isRecord(value)) throw new Error("health response is not an object");
  if (value.rt !== undefined && typeof value.rt !== "boolean")
    throw new Error("health.rt is not boolean");
  if (value.gbfs !== undefined && typeof value.gbfs !== "boolean")
    throw new Error("health.gbfs is not boolean");
  if (expectsGbfs && value.gbfs !== true)
    throw new Error("candidate expects GBFS but health.gbfs is not true");
  return value as HealthResponse;
}

function decodeInitial(value: unknown): InitialResponse {
  if (!isRecord(value) || typeof value.lat !== "number" || typeof value.lon !== "number") {
    throw new Error("initial response lacks numeric lat/lon");
  }
  if (!isRecord(value.serverConfig)) throw new Error("initial response lacks serverConfig");
  return value as InitialResponse;
}

function finiteLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function observedReachability(initial: InitialResponse): ObservedReachabilityCapabilities {
  const config = initial.serverConfig as unknown as JsonRecord;
  return {
    motisVersion: typeof config.motisVersion === "string" ? config.motisVersion : null,
    hasStreetRouting: config.hasStreetRouting === true,
    maxOneToManySize: finiteLimit(config.maxOneToManySize),
    maxOneToAllTravelTimeMinutes: finiteLimit(config.maxOneToAllTravelTimeLimit),
    maxPrePostTransitSeconds: finiteLimit(config.maxPrePostTransitTimeLimit),
    maxDirectSeconds: finiteLimit(config.maxDirectTimeLimit),
    oneToManyIntermodalVerified: false,
    canaryDurationMs: null,
  };
}

function decodeOneToManyIntermodal(value: unknown): void {
  if (!isRecord(value)) throw new Error("one-to-many response is not an object");
  if (!Array.isArray(value.street_durations) || value.street_durations.length !== 1) {
    throw new Error("one-to-many street durations do not align with destinations");
  }
  if (!Array.isArray(value.transit_durations) || value.transit_durations.length !== 1) {
    throw new Error("one-to-many transit durations do not align with destinations");
  }
}

function decodeStops(value: unknown): StopsResponse {
  if (!Array.isArray(value)) throw new Error("stops response is not an array");
  return value as StopsResponse;
}

function decodePlan(value: unknown, requireItinerary: boolean): PlanResponse {
  if (!isRecord(value) || !Array.isArray(value.itineraries) || !Array.isArray(value.direct)) {
    throw new Error("plan response lacks itineraries/direct arrays");
  }
  if (requireItinerary && value.itineraries.length + value.direct.length === 0) {
    throw new Error("plan response contains no itinerary");
  }
  return value as PlanResponse;
}

function decodeRentals(
  value: unknown,
  expectedIds: string[],
): {
  response: RentalsResponse;
  observed: ObservedRentalCapabilities;
} {
  if (!isRecord(value)) throw new Error("rentals response is not an object");
  for (const key of ["providerGroups", "providers", "stations", "vehicles", "zones"]) {
    if (!Array.isArray(value[key])) throw new Error(`rentals.${key} is not an array`);
  }
  const response = value as RentalsResponse;
  const providerIds = response.providers
    .map((provider) => provider.id)
    .filter(Boolean)
    .sort();
  const groupIds = response.providerGroups
    .map((group) => group.id)
    .filter(Boolean)
    .sort();
  if (providerIds.length === 0 && groupIds.length === 0) {
    throw new Error("rentals provider enumeration is empty");
  }
  for (const id of expectedIds) {
    if (!providerIds.includes(id) && !groupIds.includes(id)) {
      throw new Error(`expected rental provider/group ${id} is absent`);
    }
  }
  const formFactors = new Set<string>();
  const returnConstraints = new Set<string>();
  const providerBboxes: Record<string, [number, number, number, number]> = {};
  for (const provider of response.providers) {
    if (
      !provider.id ||
      !Array.isArray(provider.formFactors) ||
      !Array.isArray(provider.vehicleTypes)
    ) {
      throw new Error("rentals provider has an invalid shape");
    }
    for (const factor of provider.formFactors) formFactors.add(factor);
    for (const vehicleType of provider.vehicleTypes) {
      formFactors.add(vehicleType.formFactor);
      returnConstraints.add(vehicleType.returnConstraint);
    }
    if (
      Array.isArray(provider.bbox) &&
      provider.bbox.length === 4 &&
      provider.bbox.every(Number.isFinite)
    ) {
      providerBboxes[provider.id] = provider.bbox;
    }
  }
  return {
    response,
    observed: {
      providerIds,
      providerGroupIds: groupIds,
      formFactors: [...formFactors].sort(),
      returnConstraints: [...returnConstraints].sort(),
      providerBboxes,
    },
  };
}

async function execute<T>(
  name: string,
  url: string,
  deadline: number,
  decode: (value: unknown) => T,
): Promise<{ outcome: ProbeOutcome; value?: T }> {
  const start = Date.now();
  try {
    const remaining = deadline - start;
    if (remaining <= 0) throw new Error("functional probe deadline exceeded");
    const response = await fetchWithTimeout(url, Math.min(DEFAULT_PROBE_TIMEOUT_MS, remaining));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json"))
      throw new Error(`unexpected content-type ${contentType || "(none)"}`);
    const value = decode(await response.json());
    return { outcome: { name, url, durationMs: Date.now() - start, ok: true }, value };
  } catch (error) {
    return {
      outcome: {
        name,
        url,
        durationMs: Date.now() - start,
        ok: false,
        evidence: (error as Error).message,
      },
    };
  }
}

async function executeOneToManyCanary(
  baseUrl: string,
  manifest: MotisCandidateManifest,
  deadline: number,
): Promise<ProbeOutcome> {
  const url = oneToManyIntermodalUrl(baseUrl);
  const start = Date.now();
  try {
    const remaining = deadline - start;
    if (remaining <= 0) throw new Error("functional probe deadline exceeded");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("request timed out")),
      Math.min(DEFAULT_PROBE_TIMEOUT_MS, remaining),
    );
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          one: `${manifest.canary.plan.fromLat},${manifest.canary.plan.fromLng}`,
          many: [`${manifest.canary.plan.toLat},${manifest.canary.plan.toLng}`],
          maxTravelTime: 15,
          arriveBy: false,
          pedestrianProfile: "FOOT",
          pedestrianSpeed: 1.2,
          preTransitModes: ["WALK"],
          postTransitModes: ["WALK"],
          directMode: "WALK",
          maxPreTransitTime: 900,
          maxPostTransitTime: 900,
          maxDirectTime: 900,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      throw new Error(`unexpected content-type ${contentType || "(none)"}`);
    }
    decodeOneToManyIntermodal(await response.json());
    return { name: "one-to-many-intermodal", url, durationMs: Date.now() - start, ok: true };
  } catch (error) {
    return {
      name: "one-to-many-intermodal",
      url,
      durationMs: Date.now() - start,
      ok: false,
      evidence: (error as Error).message.slice(0, 240),
    };
  }
}

const DEFAULT_RENTALS_WARMUP_MS = 180_000;
const DEFAULT_RENTALS_POLL_INTERVAL_MS = 5_000;

export interface RunFunctionalProbesOptions {
  /** Injected in tests so warm-up polling doesn't sleep in real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * How long to keep re-polling the `rentals` probe while it enumerates zero
   * providers. MOTIS answers `/health` as soon as the timetable loads, but
   * fetches GBFS rentals asynchronously afterward — so a freshly (re)started
   * instance reports empty rentals for the first few seconds. Default 180s;
   * override with `MOTIS_RENTALS_WARMUP_MS`.
   */
  rentalsWarmupMs?: number;
  /** Interval between rentals warm-up polls. Override with `MOTIS_RENTALS_POLL_INTERVAL_MS`. */
  rentalsPollIntervalMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one probe, retrying while it fails for up to `warmupMs` (bounded by attempt
 * count so it terminates deterministically even under an instant/no-op sleep).
 * Used for the `rentals` probe, whose failure right after (re)start is expected
 * GBFS warm-up rather than a real capability regression.
 */
async function executeWithWarmup<T>(
  name: string,
  url: string,
  decode: (value: unknown) => T,
  warmupMs: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ outcome: ProbeOutcome; value?: T }> {
  const interval = Math.max(1, intervalMs);
  const maxAttempts = Math.max(1, Math.ceil(warmupMs / interval));
  const warmupDeadline = Date.now() + warmupMs;
  let result = await execute(name, url, warmupDeadline, decode);
  let attempts = 1;
  while (!result.outcome.ok && attempts < maxAttempts && Date.now() < warmupDeadline) {
    await sleep(interval);
    result = await execute(name, url, warmupDeadline, decode);
    attempts++;
  }
  return result;
}

/** Identical, bounded capability gate used before and after dataset activation. */
export async function runFunctionalProbes(
  baseUrl: string,
  manifest: MotisCandidateManifest,
  deadline: number,
  options: RunFunctionalProbesOptions = {},
): Promise<FunctionalProbeReport> {
  const sleep = options.sleep ?? realSleep;
  const rentalsWarmupMs =
    options.rentalsWarmupMs ?? parseIntEnv("MOTIS_RENTALS_WARMUP_MS", DEFAULT_RENTALS_WARMUP_MS);
  const rentalsPollIntervalMs =
    options.rentalsPollIntervalMs ??
    parseIntEnv("MOTIS_RENTALS_POLL_INTERVAL_MS", DEFAULT_RENTALS_POLL_INTERVAL_MS);
  const outcomes: ProbeOutcome[] = [];
  let health: HealthResponse | undefined;
  let rentals: ObservedRentalCapabilities | undefined;
  let reachability: ObservedReachabilityCapabilities = {
    motisVersion: null,
    hasStreetRouting: false,
    maxOneToManySize: 0,
    maxOneToAllTravelTimeMinutes: 0,
    maxPrePostTransitSeconds: 0,
    maxDirectSeconds: 0,
    oneToManyIntermodalVerified: false,
    canaryDurationMs: null,
  };
  const planningFeatures = { hasRoutedTransfers: false, hasElevation: false };
  const specs: Array<{
    name: string;
    url: string;
    decode: (value: unknown) => unknown;
    accept: (value: unknown) => void;
    required?: boolean;
    /** When set, re-poll on failure for this long to absorb GBFS warm-up. */
    warmupMs?: number;
  }> = [
    {
      name: "health",
      url: healthUrl(baseUrl),
      decode: (v) => decodeHealth(v, manifest.expectations.expectsGbfs),
      accept: (v) => {
        health = v as HealthResponse;
      },
    },
    {
      name: "initial",
      url: mapInitialUrl(baseUrl),
      decode: decodeInitial,
      accept: (value) => {
        reachability = observedReachability(value as InitialResponse);
      },
    },
    {
      name: "stops",
      url: mapStopsUrl(baseUrl, manifest.canary.bbox),
      decode: decodeStops,
      accept: () => undefined,
    },
    {
      name: "plan",
      url: planUrl(baseUrl, manifest.canary.plan),
      decode: (v) => decodePlan(v, true),
      accept: () => undefined,
    },
    {
      name: "plan-routed-transfers",
      url: routedTransferPlanUrl(baseUrl, manifest.canary.plan),
      decode: (v) => decodePlan(v, false),
      accept: () => {
        planningFeatures.hasRoutedTransfers = true;
      },
      required: false,
    },
    {
      name: "plan-elevation",
      url: elevationPlanUrl(baseUrl, manifest.canary.plan),
      decode: (v) => decodePlan(v, false),
      accept: () => {
        planningFeatures.hasElevation = true;
      },
      required: false,
    },
  ];
  if (manifest.expectations.expectsGbfs) {
    specs.push({
      name: "rentals",
      url: rentalsUrl(baseUrl, manifest.canary.bbox),
      decode: (v) => decodeRentals(v, manifest.canary.expectedRentalProviderIds),
      accept: (v) => {
        rentals = (v as ReturnType<typeof decodeRentals>).observed;
      },
      warmupMs: rentalsWarmupMs,
    });
  }
  if (manifest.canary.rentalPlan) {
    specs.push({
      name: "rental-plan",
      url: rentalPlanUrl(baseUrl, manifest.canary.rentalPlan),
      decode: (v) => decodePlan(v, true),
      accept: () => undefined,
    });
  }
  for (const spec of specs) {
    const result =
      spec.warmupMs && spec.warmupMs > 0
        ? await executeWithWarmup(
            spec.name,
            spec.url,
            spec.decode,
            spec.warmupMs,
            rentalsPollIntervalMs,
            sleep,
          )
        : await execute(spec.name, spec.url, deadline, spec.decode);
    outcomes.push(result.outcome);
    if (!result.outcome.ok) {
      if (spec.required === false) continue;
      return {
        ok: false,
        outcomes,
        failure: result.outcome,
        health,
        rentals,
        planningFeatures,
        reachability,
      };
    }
    spec.accept(result.value);
  }
  if (reachability.hasStreetRouting && reachability.maxOneToManySize > 0) {
    const canary = await executeOneToManyCanary(baseUrl, manifest, deadline);
    outcomes.push(canary);
    reachability = {
      ...reachability,
      oneToManyIntermodalVerified: canary.ok,
      canaryDurationMs: canary.durationMs,
    };
  }
  return { ok: true, outcomes, health, rentals, planningFeatures, reachability };
}

export interface CapabilitySnapshot {
  schemaVersion: 1;
  testedAt: string;
  epoch: string;
  pins: {
    motis: string;
    transitous: string;
    atlas?: string;
    gbfsRegistry?: { commit: string; sha256: string };
  };
  artifacts: MotisCandidateManifest["artifacts"];
  expectations: MotisCandidateManifest["expectations"];
  health: HealthResponse;
  rentals?: ObservedRentalCapabilities;
  planningFeatures: { hasRoutedTransfers: boolean; hasElevation: boolean };
  reachability?: ObservedReachabilityCapabilities;
  probes: ProbeOutcome[];
}

export function writeCapabilitySnapshot(
  stagingDir: string,
  repoRoot: string,
  manifest: MotisCandidateManifest,
  report: FunctionalProbeReport,
  testedAt: string,
): CapabilitySnapshot {
  if (!report.ok || !report.health)
    throw new Error("cannot persist an unsuccessful capability report");
  const lock = readTransitousLock(repoRoot);
  let gbfsRegistry: { commit: string; sha256: string } | undefined;
  if (manifest.artifacts.sourceIndex) {
    try {
      const index = JSON.parse(
        readFileSync(join(stagingDir, manifest.artifacts.sourceIndex.path), "utf-8"),
      ) as {
        lock?: { commit?: unknown; sha256?: unknown };
      };
      if (typeof index.lock?.commit === "string" && typeof index.lock.sha256 === "string") {
        gbfsRegistry = { commit: index.lock.commit, sha256: index.lock.sha256 };
      }
    } catch {
      // The source-index hash remains promotion-gated; malformed optional pin
      // metadata is surfaced by admin rather than exposing secrets here.
    }
  }
  const snapshot: CapabilitySnapshot = {
    schemaVersion: 1,
    testedAt,
    epoch: manifest.epoch,
    pins: {
      motis: MOTIS_VERSION,
      transitous: lock?.ref ?? "unlocked",
      atlas: lock?.submodules["transitland-atlas"],
      gbfsRegistry,
    },
    artifacts: manifest.artifacts,
    expectations: manifest.expectations,
    health: report.health,
    rentals: report.rentals,
    planningFeatures: report.planningFeatures,
    reachability: report.reachability,
    probes: report.outcomes,
  };
  const output = join(stagingDir, CAPABILITY_SNAPSHOT_FILENAME);
  atomicWriteJsonSync(output, snapshot, { durability: "full" });
  return snapshot;
}

export function readCapabilitySnapshot(dir: string): CapabilitySnapshot {
  const parsed: unknown = JSON.parse(
    readFileSync(join(dir, CAPABILITY_SNAPSHOT_FILENAME), "utf-8"),
  );
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.epoch !== "string") {
    throw new Error("unsupported or malformed capability snapshot");
  }
  return parsed as unknown as CapabilitySnapshot;
}

export function verifyCapabilitySnapshot(
  dir: string,
  manifest: MotisCandidateManifest,
): CapabilitySnapshot {
  const snapshot = readCapabilitySnapshot(dir);
  if (snapshot.epoch !== manifest.epoch)
    throw new Error("capability snapshot epoch does not match candidate");
  if (
    snapshot.artifacts.config.sha256 !== manifest.artifacts.config.sha256 ||
    snapshot.artifacts.license.sha256 !== manifest.artifacts.license.sha256
  ) {
    throw new Error("capability snapshot artifact hashes do not match candidate");
  }
  return snapshot;
}
