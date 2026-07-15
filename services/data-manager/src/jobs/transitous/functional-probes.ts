import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
import { CAPABILITY_SNAPSHOT_FILENAME, type MotisCandidateManifest } from "./candidate.js";
import {
  elevationPlanUrl,
  healthUrl,
  mapInitialUrl,
  mapStopsUrl,
  planUrl,
  rentalPlanUrl,
  rentalsUrl,
  routedTransferPlanUrl,
} from "./motis-endpoints.js";
import { DEFAULT_PROBE_TIMEOUT_MS, fetchWithTimeout } from "./motis-probe.js";

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

export interface FunctionalProbeReport {
  ok: boolean;
  outcomes: ProbeOutcome[];
  health?: HealthResponse;
  rentals?: ObservedRentalCapabilities;
  planningFeatures: { hasRoutedTransfers: boolean; hasElevation: boolean };
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

/** Identical, bounded capability gate used before and after dataset activation. */
export async function runFunctionalProbes(
  baseUrl: string,
  manifest: MotisCandidateManifest,
  deadline: number,
): Promise<FunctionalProbeReport> {
  const outcomes: ProbeOutcome[] = [];
  let health: HealthResponse | undefined;
  let rentals: ObservedRentalCapabilities | undefined;
  const planningFeatures = { hasRoutedTransfers: false, hasElevation: false };
  const specs: Array<{
    name: string;
    url: string;
    decode: (value: unknown) => unknown;
    accept: (value: unknown) => void;
    required?: boolean;
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
      accept: () => undefined,
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
    const result = await execute(spec.name, spec.url, deadline, spec.decode);
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
      };
    }
    spec.accept(result.value);
  }
  return { ok: true, outcomes, health, rentals, planningFeatures };
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
    probes: report.outcomes,
  };
  const output = join(stagingDir, CAPABILITY_SNAPSHOT_FILENAME);
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  renameSync(temporary, output);
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
