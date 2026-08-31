import { dedupStations } from "./dedup.js";
import { fetchMotisRentals } from "./motis-rentals.js";
import type { BoundingBox } from "./types/geometry.js";
import type {
  MotisRentalSnapshot,
  SharedMobilityStation,
  SharedMobilityVehicle,
  VehicleFormFactor,
} from "./types/shared-mobility.js";

export type SharedMobilitySourcePolicy = "fanout" | "shadow" | "motis-first";
export type SharedMobilityAdapterKind = "fallback" | "proprietary";

export interface SharedMobilityInventory {
  stations: SharedMobilityStation[];
  vehicles: SharedMobilityVehicle[];
}

export interface SharedMobilityAdapter {
  id: string;
  kind: SharedMobilityAdapterKind;
  fetch(bbox: BoundingBox): Promise<SharedMobilityInventory>;
}

export interface SharedMobilitySourceDecision {
  policy: SharedMobilitySourcePolicy;
  local: "healthy" | "partial" | "error";
  served: "motis-first" | "fanout";
  calledAdapters: string[];
  skippedAdapters: string[];
  partial: boolean;
  stationDelta?: number;
  vehicleDelta?: number;
}

export interface SharedMobilityOrchestratorConfig {
  category: "bike" | "scooter" | "car";
  formFactors: ReadonlySet<VehicleFormFactor>;
  motisFormFactors: VehicleFormFactor[];
  adapters: SharedMobilityAdapter[];
  policy?: SharedMobilitySourcePolicy;
  /** Provider/region rollback IDs force fanout without a deployment. */
  denylist?: ReadonlySet<string>;
  onDecision?: (decision: SharedMobilitySourceDecision) => void;
  fetchMotis?: typeof fetchMotisRentals;
}

export interface SharedMobilityOrchestratorResult extends SharedMobilityInventory {
  snapshot: MotisRentalSnapshot | null;
  decision: SharedMobilitySourceDecision;
}

export type SharedMobilityCategory = SharedMobilityOrchestratorConfig["category"];

interface SharedMobilityDecisionRecord {
  category: SharedMobilityCategory;
  decision: SharedMobilitySourceDecision;
  recordedAt: string;
}

const rollbackDenylist = new Set<SharedMobilityCategory>();
const latestDecisions = new Map<SharedMobilityCategory, SharedMobilityDecisionRecord>();
let decisionObserver:
  | ((category: SharedMobilityCategory, decision: SharedMobilitySourceDecision) => void)
  | null = null;

export function setSharedMobilityDecisionObserver(
  observer:
    | ((category: SharedMobilityCategory, decision: SharedMobilitySourceDecision) => void)
    | null,
): void {
  decisionObserver = observer;
}

export function setSharedMobilityRollback(
  category: SharedMobilityCategory,
  enabled: boolean,
): void {
  if (enabled) rollbackDenylist.add(category);
  else rollbackDenylist.delete(category);
}

export function getSharedMobilityOperationsState(): {
  rollbackCategories: SharedMobilityCategory[];
  decisions: SharedMobilityDecisionRecord[];
} {
  return {
    rollbackCategories: [...rollbackDenylist].sort(),
    decisions: [...latestDecisions.values()].sort((left, right) =>
      left.category.localeCompare(right.category),
    ),
  };
}

const ALLOWED_POLICIES = new Set<SharedMobilitySourcePolicy>(["fanout", "shadow", "motis-first"]);

export function resolveSharedMobilitySourcePolicy(
  configured = process.env.SHARED_MOBILITY_SOURCE_POLICY,
): SharedMobilitySourcePolicy {
  // Default to `fanout`, not `motis-first`. MOTIS ingests only a curated subset
  // of GBFS feeds (the pinned Transitous catalog), whereas the direct GBFS
  // adapter covers the full MobilityData registry (hundreds of operators per
  // country). Under `motis-first` the direct adapters are skipped whenever MOTIS
  // reports "healthy" — including an empty-but-complete result for an area MOTIS
  // has no feed for — which collapsed map coverage to MOTIS's handful of feeds.
  // `fanout` queries MOTIS + all direct GBFS + proprietary adapters and dedups
  // (MOTIS stays authoritative for the operators it does carry), restoring the
  // broad coverage while keeping MOTIS's curated feeds for intermodal routing.
  // Operators who genuinely want MOTIS-only can still set the env var.
  return ALLOWED_POLICIES.has(configured as SharedMobilitySourcePolicy)
    ? (configured as SharedMobilitySourcePolicy)
    : "fanout";
}

function canonicalStationIdentity(station: SharedMobilityStation): string | null {
  const provider = station.providerId ?? station.systemId;
  const native = station.nativeId;
  return provider && native ? `${provider}\0${native}` : null;
}

function canonicalVehicleIdentity(vehicle: SharedMobilityVehicle): string | null {
  const provider = vehicle.providerId ?? vehicle.systemId;
  const native = vehicle.nativeId;
  return provider && native ? `${provider}\0${native}` : null;
}

function fillStationMetadata(
  authoritative: SharedMobilityStation,
  enrichment: SharedMobilityStation,
): void {
  authoritative.capacity ??= enrichment.capacity;
  authoritative.address ??= enrichment.address;
  authoritative.crossStreet ??= enrichment.crossStreet;
  authoritative.branding ??= enrichment.branding;
  authoritative.rentalApps ??= enrichment.rentalApps;
  authoritative.rentalUris ??= enrichment.rentalUris;
  authoritative.website ??= enrichment.website;
  authoritative.vehicleTypeDetails ??= enrichment.vehicleTypeDetails;
  authoritative.vehicleClassNames ??= enrichment.vehicleClassNames;
  authoritative.pricingSummary ??= enrichment.pricingSummary;
  authoritative.pricingDetails ??= enrichment.pricingDetails;
  authoritative.sources = [...new Set([...authoritative.sources, ...enrichment.sources])];
}

function fillVehicleMetadata(
  authoritative: SharedMobilityVehicle,
  enrichment: SharedMobilityVehicle,
): void {
  authoritative.batteryLevel ??= enrichment.batteryLevel;
  authoritative.rangeMeters ??= enrichment.rangeMeters;
  authoritative.branding ??= enrichment.branding;
  authoritative.rentalApps ??= enrichment.rentalApps;
  authoritative.rentalUris ??= enrichment.rentalUris;
  authoritative.vehicleImageUrl ??= enrichment.vehicleImageUrl;
  authoritative.vehicleIconUrl ??= enrichment.vehicleIconUrl;
  authoritative.vehicleIconUrlDark ??= enrichment.vehicleIconUrlDark;
  authoritative.sources = [...new Set([...authoritative.sources, ...enrichment.sources])];
}

/**
 * Merge direct metadata into MOTIS inventory without allowing stale direct
 * operational state to replace MOTIS coordinates, availability, status,
 * provider/type identity, station assignment, or return constraints.
 */
export function mergeMotisFirstInventory(
  motis: SharedMobilityInventory,
  supplements: SharedMobilityInventory[],
): SharedMobilityInventory {
  const stations = motis.stations.map((station) => structuredClone(station));
  const vehicles = motis.vehicles.map((vehicle) => structuredClone(vehicle));
  const stationByIdentity = new Map(
    stations
      .map((station) => [canonicalStationIdentity(station), station] as const)
      .filter((entry): entry is [string, SharedMobilityStation] => entry[0] !== null),
  );
  const vehicleByIdentity = new Map(
    vehicles
      .map((vehicle) => [canonicalVehicleIdentity(vehicle), vehicle] as const)
      .filter((entry): entry is [string, SharedMobilityVehicle] => entry[0] !== null),
  );

  for (const supplement of supplements) {
    for (const station of supplement.stations) {
      const identity = canonicalStationIdentity(station);
      const match = identity ? stationByIdentity.get(identity) : undefined;
      if (match) fillStationMetadata(match, station);
      else stations.push(station);
    }
    for (const vehicle of supplement.vehicles) {
      const identity = canonicalVehicleIdentity(vehicle);
      const match = identity ? vehicleByIdentity.get(identity) : undefined;
      if (match) fillVehicleMetadata(match, vehicle);
      else vehicles.push(vehicle);
    }
  }

  // Station spatial fallback remains provider-scoped in dedupStations. Vehicle
  // merging above is exact identity only and never spatial.
  return { stations: dedupStations(stations), vehicles };
}

function inventory(snapshot: MotisRentalSnapshot | null): SharedMobilityInventory {
  return { stations: snapshot?.stations ?? [], vehicles: snapshot?.vehicles ?? [] };
}

/** Wall-clock bounds so a hung/orphaned upstream fetch can't stall orchestration. */
const MOTIS_FETCH_TIMEOUT_MS = 12_000;
const ADAPTER_FETCH_TIMEOUT_MS = 15_000;

/**
 * Race a fetch against an independent timer that resolves to `fallback`. A
 * malformed upstream response can crash undici's HTTP parser and leave the
 * originating fetch permanently unsettled (its own AbortController can't rescue
 * a dead parser); this top-level bound guarantees each adapter — and the MOTIS
 * snapshot — settles regardless of any orphan inside it, so a single flaky feed
 * can't hang the whole shared-mobility request.
 */
function boundFetch<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function orchestrateSharedMobility(
  bbox: BoundingBox,
  config: SharedMobilityOrchestratorConfig,
): Promise<SharedMobilityOrchestratorResult> {
  const requestedPolicy = config.policy ?? resolveSharedMobilitySourcePolicy();
  const policy =
    config.denylist?.has(config.category) || rollbackDenylist.has(config.category)
      ? "fanout"
      : requestedPolicy;
  const fetchLocal = config.fetchMotis ?? fetchMotisRentals;
  let snapshot: MotisRentalSnapshot | null = null;
  let local: SharedMobilitySourceDecision["local"] = "error";
  try {
    snapshot = await boundFetch(
      fetchLocal([bbox.west, bbox.south, bbox.east, bbox.north], config.motisFormFactors),
      MOTIS_FETCH_TIMEOUT_MS,
      null,
    );
    local =
      snapshot?.completeness?.stations && snapshot?.completeness?.vehicles
        ? "healthy"
        : snapshot
          ? "partial"
          : "error";
  } catch {
    snapshot = null;
  }

  const shouldCall = (adapter: SharedMobilityAdapter): boolean => {
    if (adapter.kind === "proprietary") return true;
    return policy !== "motis-first" || local !== "healthy";
  };
  const called = config.adapters.filter(shouldCall);
  const skipped = config.adapters.filter((adapter) => !shouldCall(adapter));
  const settled = await Promise.allSettled(
    called.map((adapter) =>
      boundFetch(adapter.fetch(bbox), ADAPTER_FETCH_TIMEOUT_MS, { stations: [], vehicles: [] }),
    ),
  );
  const supplements = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const fanoutInventory = mergeMotisFirstInventory(inventory(snapshot), supplements);
  const served = policy === "fanout" ? "fanout" : "motis-first";
  const resultInventory = fanoutInventory;
  const decision: SharedMobilitySourceDecision = {
    policy,
    local,
    served,
    calledAdapters: called.map((adapter) => adapter.id),
    skippedAdapters: skipped.map((adapter) => adapter.id),
    partial: local !== "healthy" || settled.some((result) => result.status === "rejected"),
    ...(policy === "shadow"
      ? {
          stationDelta: fanoutInventory.stations.length - inventory(snapshot).stations.length,
          vehicleDelta: fanoutInventory.vehicles.length - inventory(snapshot).vehicles.length,
        }
      : {}),
  };
  latestDecisions.set(config.category, {
    category: config.category,
    decision,
    recordedAt: new Date().toISOString(),
  });
  decisionObserver?.(config.category, decision);
  config.onDecision?.(decision);
  return { ...resultInventory, snapshot, decision };
}
