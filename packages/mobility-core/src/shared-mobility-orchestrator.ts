import { contributionState, retainContributions } from "./contribution-merge.js";
import { withContributors } from "./contributors.js";
import { dedupStations } from "./dedup.js";
import type { MotisRentalsClient } from "./motis-rentals.js";
import type { Attribution } from "./types/attribution.js";
import type { BoundingBox } from "./types/geometry.js";
import type {
  MotisRentalSnapshot,
  SharedMobilityStation,
  SharedMobilityVehicle,
  VehicleFormFactor,
} from "./types/shared-mobility.js";

export interface SharedMobilityInventory {
  stations: SharedMobilityStation[];
  vehicles: SharedMobilityVehicle[];
}

export interface SharedMobilityAdapter {
  id: string;
  fetch(bbox: BoundingBox): Promise<SharedMobilityInventory>;
}

export interface SharedMobilitySourceDecision {
  local: "healthy" | "partial" | "error";
  calledAdapters: string[];
  partial: boolean;
}

export interface SharedMobilityOrchestratorConfig {
  category: "bike" | "scooter" | "car";
  motisFormFactors: VehicleFormFactor[];
  adapters: SharedMobilityAdapter[];
  onDecision?: (decision: SharedMobilitySourceDecision) => void;
  fetchMotis: MotisRentalsClient["fetchMotisRentals"];
  resolveContributors?: (sourceIds: readonly string[]) => Attribution[];
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

const latestDecisions = new Map<SharedMobilityCategory, SharedMobilityDecisionRecord>();

export function getSharedMobilityOperationsState(): {
  decisions: SharedMobilityDecisionRecord[];
} {
  return {
    decisions: [...latestDecisions.values()].sort((left, right) =>
      left.category.localeCompare(right.category),
    ),
  };
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

const STATION_METADATA_FIELDS = [
  "capacity",
  "address",
  "crossStreet",
  "branding",
  "rentalApps",
  "rentalUris",
  "website",
  "vehicleTypeDetails",
  "vehicleClassNames",
  "pricingSummary",
  "pricingDetails",
] as const;
const VEHICLE_METADATA_FIELDS = [
  "batteryLevel",
  "rangeMeters",
  "branding",
  "rentalApps",
  "rentalUris",
  "vehicleImageUrl",
  "vehicleIconUrl",
  "vehicleIconUrlDark",
] as const;

function fillStationMetadata(
  authoritative: SharedMobilityStation,
  enrichment: SharedMobilityStation,
): void {
  const before = contributionState(authoritative, STATION_METADATA_FIELDS);
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
  if (contributionState(authoritative, STATION_METADATA_FIELDS) !== before)
    retainContributions(authoritative, enrichment);
}

function fillVehicleMetadata(
  authoritative: SharedMobilityVehicle,
  enrichment: SharedMobilityVehicle,
): void {
  const before = contributionState(authoritative, VEHICLE_METADATA_FIELDS);
  authoritative.batteryLevel ??= enrichment.batteryLevel;
  authoritative.rangeMeters ??= enrichment.rangeMeters;
  authoritative.branding ??= enrichment.branding;
  authoritative.rentalApps ??= enrichment.rentalApps;
  authoritative.rentalUris ??= enrichment.rentalUris;
  authoritative.vehicleImageUrl ??= enrichment.vehicleImageUrl;
  authoritative.vehicleIconUrl ??= enrichment.vehicleIconUrl;
  authoritative.vehicleIconUrlDark ??= enrichment.vehicleIconUrlDark;
  if (contributionState(authoritative, VEHICLE_METADATA_FIELDS) !== before)
    retainContributions(authoritative, enrichment);
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
  let snapshot: MotisRentalSnapshot | null = null;
  let local: SharedMobilitySourceDecision["local"] = "error";
  try {
    snapshot = await boundFetch(
      config.fetchMotis(
        [bbox.west, bbox.south, bbox.east, bbox.north],
        config.motisFormFactors,
        config.resolveContributors,
      ),
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

  const settled = await Promise.allSettled(
    config.adapters.map((adapter) =>
      boundFetch(adapter.fetch(bbox), ADAPTER_FETCH_TIMEOUT_MS, { stations: [], vehicles: [] }),
    ),
  );
  const supplements = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const capture = <T extends SharedMobilityStation | SharedMobilityVehicle>(item: T): T =>
    item.contributors !== undefined || !config.resolveContributors
      ? item
      : withContributors(item, config.resolveContributors(item.sources));
  const capturedInventory = (items: SharedMobilityInventory): SharedMobilityInventory => ({
    stations: items.stations.map(capture),
    vehicles: items.vehicles.map(capture),
  });
  const resultInventory = mergeMotisFirstInventory(
    capturedInventory(inventory(snapshot)),
    supplements.map(capturedInventory),
  );
  const decision: SharedMobilitySourceDecision = {
    local,
    calledAdapters: config.adapters.map((adapter) => adapter.id),
    partial: local !== "healthy" || settled.some((result) => result.status === "rejected"),
  };
  latestDecisions.set(config.category, {
    category: config.category,
    decision,
    recordedAt: new Date().toISOString(),
  });
  config.onDecision?.(decision);
  return { ...resultInventory, snapshot, decision };
}
