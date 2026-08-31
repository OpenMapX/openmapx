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
  onDecision?: (category: SharedMobilityCategory, decision: SharedMobilitySourceDecision) => void;
}

export type RuntimeSharedMobilityOrchestratorConfig = Omit<
  SharedMobilityOrchestratorConfig,
  "fetchMotis" | "onDecision"
>;

export interface SharedMobilityRuntime {
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
  ): Promise<MotisRentalSnapshot>;
  enrichEnturMobilityItems(
    stations: SharedMobilityStation[],
    vehicles: SharedMobilityVehicle[],
    scope?: "map" | "detail",
  ): Promise<void>;
  buildEnturGeofencingMapContext(
    bbox: BoundingBox,
    options?: { systemIds?: string[]; vehicleTypeIds?: string[] },
  ): Promise<SharedMobilityMapContext | null>;
  orchestrate(
    bbox: BoundingBox,
    config: RuntimeSharedMobilityOrchestratorConfig,
  ): Promise<SharedMobilityOrchestratorResult>;
}

export function createSharedMobilityRuntime(
  options: SharedMobilityRuntimeOptions,
): SharedMobilityRuntime {
  const catalog = createGbfsCatalogClient({ cache: options.cache, transport: options.transport });
  const nominatim = createNominatimClient({
    transport: options.transport,
    url: options.nominatimUrl,
  });
  const motis = createMotisRentalsClient({
    motisUrl: options.motisUrl,
    transitousUrl: options.transitousUrl,
    rentalSourceIndex: options.rentalSourceIndex,
  });
  const gbfsDependencies = {
    cache: options.cache,
    catalog,
    nominatim,
    transport: options.transport,
  };
  const enturDependencies = {
    cache: options.cache,
    catalog,
    transport: options.transport,
  };

  return {
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
    enrichEnturMobilityItems: (stations, vehicles, scope) =>
      enrichEnturMobilityItems(stations, vehicles, { ...enturDependencies, scope }),
    buildEnturGeofencingMapContext: (bbox, contextOptions = {}) =>
      buildEnturGeofencingMapContext(bbox, { ...enturDependencies, ...contextOptions }),
    orchestrate: (bbox, config) =>
      orchestrateSharedMobility(bbox, {
        ...config,
        fetchMotis: motis.fetchMotisRentals,
        onDecision: (decision) => options.onDecision?.(config.category, decision),
      }),
  };
}
