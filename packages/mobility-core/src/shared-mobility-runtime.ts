import type { CacheClient } from "./cache.js";
import {
  buildEnturGeofencingMapContext,
  enrichEnturMobilityItems,
  type SharedMobilityMapContext,
} from "./entur-mobility.js";
import { createGbfsCatalogClient, type GbfsSystemProbe } from "./gbfs-catalog.js";
import { fetchGbfsData, fetchSwissSharedMobilityDataForBbox } from "./gbfs-provider-base.js";
import type { MobilityHttpTransport } from "./json-transport.js";
import { createMotisRentalsClient, type MotisRentalSourceIndexEntry } from "./motis-rentals.js";
import { createNominatimClient } from "./nominatim.js";
import {
  orchestrateSharedMobility,
  type SharedMobilityCategory,
  type SharedMobilityOrchestratorConfig,
  type SharedMobilityOrchestratorResult,
  type SharedMobilitySourceDecision,
} from "./shared-mobility-orchestrator.js";
import type { Attribution } from "./types/attribution.js";
import type { BoundingBox } from "./types/geometry.js";
import type {
  GbfsCatalogEntry,
  MotisRentalSnapshot,
  SharedMobilityStation,
  SharedMobilityVehicle,
  VehicleFormFactor,
} from "./types/shared-mobility.js";

export interface SharedMobilityRuntimeOptions {
  cache: CacheClient;
  transport: MobilityHttpTransport;
  motisUrl?: string;
  transitousUrl?: string;
  nominatimUrl?: string;
  rentalSourceIndex?: readonly MotisRentalSourceIndexEntry[];
  resolveContributors?: (sourceIds: readonly string[]) => Attribution[];
  onDecision?: (category: SharedMobilityCategory, decision: SharedMobilitySourceDecision) => void;
}

export type RuntimeSharedMobilityOrchestratorConfig = Omit<
  SharedMobilityOrchestratorConfig,
  "fetchMotis" | "onDecision"
>;

export interface SharedMobilityRuntime {
  dispose(): void;
  readonly cache: CacheClient;
  readonly transport: MobilityHttpTransport;
  loadCatalog(): Promise<GbfsCatalogEntry[]>;
  probeSystem(entry: GbfsCatalogEntry): Promise<GbfsSystemProbe | null>;
  reverseGeocodeCity(lat: number, lng: number, lang?: string): Promise<string | null>;
  fetchGbfsData(
    bbox: BoundingBox,
    formFactors: Set<VehicleFormFactor>,
    unknownFormFactor?: VehicleFormFactor,
  ): Promise<{ stations: SharedMobilityStation[]; vehicles: SharedMobilityVehicle[] }>;
  fetchSwissSharedMobilityDataForBbox(
    bbox: BoundingBox,
    formFactors: Set<VehicleFormFactor>,
    unknownFormFactor?: VehicleFormFactor,
  ): Promise<{ stations: SharedMobilityStation[]; vehicles: SharedMobilityVehicle[] }>;
  fetchMotisRentals(
    bbox: [number, number, number, number],
    formFactors?: VehicleFormFactor[],
    resolveContributors?: (sourceIds: readonly string[]) => Attribution[],
  ): Promise<MotisRentalSnapshot>;
  enrichEnturMobilityItems(
    stations: SharedMobilityStation[],
    vehicles: SharedMobilityVehicle[],
    scope?: "map" | "detail",
    resolveContributors?: (sourceIds: readonly string[]) => Attribution[],
  ): Promise<void>;
  buildEnturGeofencingMapContext(
    bbox: BoundingBox,
    options?: {
      systemIds?: string[];
      vehicleTypeIds?: string[];
      resolveContributors?: (sourceIds: readonly string[]) => Attribution[];
    },
  ): Promise<SharedMobilityMapContext | null>;
  orchestrate(
    bbox: BoundingBox,
    config: RuntimeSharedMobilityOrchestratorConfig,
  ): Promise<SharedMobilityOrchestratorResult>;
}

export function createSharedMobilityRuntime(
  options: SharedMobilityRuntimeOptions,
): SharedMobilityRuntime {
  let cacheAvailable = !options.cache.onInvalidate;
  const isCacheAvailable = () => cacheAvailable;
  const catalog = createGbfsCatalogClient({
    cache: options.cache,
    transport: options.transport,
    isCacheAvailable,
  });
  const nominatim = createNominatimClient({
    transport: options.transport,
    url: options.nominatimUrl,
    isCacheAvailable,
  });
  const unsubscribe = options.cache.onInvalidate?.(({ available }) => {
    cacheAvailable = available;
    catalog.clearCache();
    nominatim.clearCache();
  });
  const motis = createMotisRentalsClient({
    motisUrl: options.motisUrl,
    transitousUrl: options.transitousUrl,
    rentalSourceIndex: options.rentalSourceIndex,
    resolveContributors: options.resolveContributors,
  });
  const gbfsDependencies = {
    cache: options.cache,
    catalog,
    nominatim,
    transport: options.transport,
    resolveContributors: options.resolveContributors,
  };
  const enturDependencies = {
    cache: options.cache,
    catalog,
    transport: options.transport,
    resolveContributors: options.resolveContributors,
  };

  return {
    dispose() {
      unsubscribe?.();
      cacheAvailable = false;
      catalog.clearCache();
      nominatim.clearCache();
    },
    cache: options.cache,
    transport: options.transport,
    loadCatalog: catalog.loadCatalog,
    probeSystem: catalog.probeSystem,
    reverseGeocodeCity: nominatim.reverseGeocodeCity,
    fetchGbfsData: (bbox, formFactors, unknownFormFactor) =>
      fetchGbfsData(bbox, formFactors, gbfsDependencies, unknownFormFactor),
    fetchSwissSharedMobilityDataForBbox: (bbox, formFactors, unknownFormFactor) =>
      fetchSwissSharedMobilityDataForBbox(bbox, formFactors, gbfsDependencies, unknownFormFactor),
    fetchMotisRentals: motis.fetchMotisRentals,
    enrichEnturMobilityItems: (
      stations,
      vehicles,
      scope,
      resolveContributors = options.resolveContributors,
    ) =>
      enrichEnturMobilityItems(stations, vehicles, {
        ...enturDependencies,
        scope,
        resolveContributors,
      }),
    buildEnturGeofencingMapContext: (bbox, contextOptions = {}) =>
      buildEnturGeofencingMapContext(bbox, { ...enturDependencies, ...contextOptions }),
    orchestrate: (bbox, config) =>
      orchestrateSharedMobility(bbox, {
        ...config,
        fetchMotis: motis.fetchMotisRentals,
        resolveContributors: config.resolveContributors ?? options.resolveContributors,
        onDecision: (decision) => options.onDecision?.(config.category, decision),
      }),
  };
}
