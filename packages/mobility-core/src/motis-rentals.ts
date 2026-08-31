import { type Client, createClient } from "@hey-api/client-fetch";
import type {
  RentalReturnConstraint as MotisRentalReturnConstraint,
  MultiPolygon,
  RentalFormFactor,
  RentalProvider,
  RentalProviderGroup,
  RentalStation,
  RentalsResponse,
  RentalVehicle,
  RentalZone,
  RentalZoneRestrictions,
} from "@motis-project/motis-client";
import { rentals } from "@motis-project/motis-client";
import { decodePolyline } from "./polyline.js";
import type { LngLat } from "./types/geometry.js";
import type {
  MotisRentalSnapshot,
  RentalReturnConstraint,
  RentalServingOrigin,
  SharedMobilityMultiPolygonGeometry,
  SharedMobilityProvider,
  SharedMobilityProviderGroup,
  SharedMobilityRestriction,
  SharedMobilityStation,
  SharedMobilityVehicle,
  SharedMobilityZone,
  VehicleFormFactor,
  VehiclePropulsion,
  VehicleTypeDetail,
} from "./types/shared-mobility.js";

interface MotisInstance {
  client: Client;
  origin: RentalServingOrigin;
}

export interface MotisRentalSourceIndexEntry {
  sourceId: string;
  registrySystemId?: string;
  providerId?: string;
}

export interface DecodedMotisRentalId {
  origin: RentalServingOrigin;
  providerId: string;
  kind: "provider" | "group" | "type" | "station" | "vehicle" | "zone";
  nativeId: string;
}

const DEFAULT_TRANSITOUS_URL = process.env.TRANSITOUS_URL ?? "https://api.transitous.org";
const DEFAULT_MOTIS_URL = process.env.MOTIS_URL ?? "http://localhost:8081";
const LOCAL_BREAKER_FAILURES = 2;
const LOCAL_BREAKER_OPEN_MS = 15_000;

let transitousUrl = DEFAULT_TRANSITOUS_URL;
let motisLocalUrl = DEFAULT_MOTIS_URL;
let localFailures = 0;
let localBreakerOpenUntil = 0;
let sourceByProvider = new Map<string, string>();

const transitousInstance: MotisInstance = {
  client: createClient({ baseUrl: transitousUrl }),
  origin: "transitous",
};

const motisLocalInstance: MotisInstance = {
  client: createClient({ baseUrl: motisLocalUrl }),
  origin: "motis-local",
};

export function setSharedMobilityTransitousUrl(url: string | undefined): void {
  const trimmed = url?.trim();
  transitousUrl = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_TRANSITOUS_URL;
  transitousInstance.client.setConfig({ baseUrl: transitousUrl });
}

export function setSharedMobilityMotisUrl(url: string | undefined): void {
  const trimmed = url?.trim();
  motisLocalUrl = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_MOTIS_URL;
  motisLocalInstance.client.setConfig({ baseUrl: motisLocalUrl });
  localFailures = 0;
  localBreakerOpenUntil = 0;
}

/** Install Plan 003's provider/feed mapping without coupling this package to data-manager files. */
export function setMotisRentalSourceIndex(entries: MotisRentalSourceIndexEntry[]): void {
  sourceByProvider = new Map<string, string>();
  for (const entry of entries) {
    if (entry.providerId) sourceByProvider.set(entry.providerId, entry.sourceId);
    if (entry.registrySystemId) sourceByProvider.set(entry.registrySystemId, entry.sourceId);
  }
}

function encodedSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodedSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function createMotisRentalId(
  origin: RentalServingOrigin,
  providerId: string,
  kind: DecodedMotisRentalId["kind"],
  nativeId: string,
): string {
  return `${origin}/${encodedSegment(providerId)}/${kind}/${encodedSegment(nativeId)}`;
}

export function decodeMotisRentalId(id: string): DecodedMotisRentalId | null {
  const parts = id.split("/");
  if (parts.length !== 4) return null;
  const [origin, providerSegment, kind, nativeSegment] = parts;
  if (origin !== "motis-local" && origin !== "transitous") return null;
  if (!kind || !["provider", "group", "type", "station", "vehicle", "zone"].includes(kind)) {
    return null;
  }
  const providerId = decodedSegment(providerSegment ?? "");
  const nativeId = decodedSegment(nativeSegment ?? "");
  if (providerId === null || nativeId === null) return null;
  return {
    origin,
    providerId,
    kind: kind as DecodedMotisRentalId["kind"],
    nativeId,
  };
}

function mapFormFactor(formFactor: RentalFormFactor): VehicleFormFactor {
  switch (formFactor) {
    case "BICYCLE":
      return "bicycle";
    case "CARGO_BICYCLE":
      return "cargo_bicycle";
    case "CAR":
      return "car";
    case "MOPED":
      return "moped";
    case "SCOOTER_STANDING":
      return "scooter_standing";
    case "SCOOTER_SEATED":
      return "scooter_seated";
    default:
      return "other";
  }
}

function mapPropulsion(propulsion: string): VehiclePropulsion | undefined {
  switch (propulsion) {
    case "HUMAN":
      return "human";
    case "ELECTRIC_ASSIST":
      return "electric_assist";
    case "ELECTRIC":
      return "electric";
    case "COMBUSTION":
      return "combustion";
    case "COMBUSTION_DIESEL":
      return "combustion_diesel";
    case "HYBRID":
      return "hybrid";
    case "PLUG_IN_HYBRID":
      return "plug_in_hybrid";
    case "HYDROGEN_FUEL_CELL":
      return "hydrogen_fuel_cell";
    default:
      return undefined;
  }
}

function mapReturnConstraint(value: MotisRentalReturnConstraint): RentalReturnConstraint {
  switch (value) {
    case "ANY_STATION":
      return "any_station";
    case "ROUNDTRIP_STATION":
      return "roundtrip_station";
    default:
      return "none";
  }
}

function scopedTypeId(origin: RentalServingOrigin, providerId: string, nativeId: string): string {
  return createMotisRentalId(origin, providerId, "type", nativeId);
}

function mapRestriction(
  restriction: RentalZoneRestrictions,
  provider: RentalProvider,
  origin: RentalServingOrigin,
): SharedMobilityRestriction {
  const vehicleTypeIds = restriction.vehicleTypeIdxs.map((index) => {
    const vehicleType = provider.vehicleTypes[index];
    if (!vehicleType) {
      throw new Error(
        `MOTIS provider ${provider.id} restriction references missing vehicle type index ${index}`,
      );
    }
    return scopedTypeId(origin, provider.id, vehicleType.id);
  });
  return {
    vehicleTypeIds,
    rideStartAllowed: restriction.rideStartAllowed,
    rideEndAllowed: restriction.rideEndAllowed,
    rideThroughAllowed: restriction.rideThroughAllowed,
    ...(restriction.stationParking === undefined
      ? {}
      : { stationParking: restriction.stationParking }),
  };
}

function sourceIdForProvider(providerId: string): string {
  return sourceByProvider.get(providerId) ?? providerId;
}

function mapVehicleType(
  providerId: string,
  origin: RentalServingOrigin,
  vehicleType: RentalProvider["vehicleTypes"][number],
): VehicleTypeDetail {
  return {
    id: scopedTypeId(origin, providerId, vehicleType.id),
    nativeId: vehicleType.id,
    name: vehicleType.name || vehicleType.id,
    formFactor: mapFormFactor(vehicleType.formFactor),
    propulsion: mapPropulsion(vehicleType.propulsionType),
    returnConstraint: mapReturnConstraint(vehicleType.returnConstraint),
    returnConstraintGuessed: vehicleType.returnConstraintGuessed,
  };
}

function mapProviderGroup(
  group: RentalProviderGroup,
  origin: RentalServingOrigin,
): SharedMobilityProviderGroup {
  return {
    id: createMotisRentalId(origin, group.id, "group", group.id),
    nativeId: group.id,
    name: group.name || group.id,
    color: group.color || undefined,
    providerIds: group.providers.map((providerId) =>
      createMotisRentalId(origin, providerId, "provider", providerId),
    ),
    formFactors: group.formFactors.map(mapFormFactor),
  };
}

function mapProvider(
  provider: RentalProvider,
  origin: RentalServingOrigin,
): SharedMobilityProvider {
  const sourceId = sourceIdForProvider(provider.id);
  return {
    id: createMotisRentalId(origin, provider.id, "provider", provider.id),
    nativeId: provider.id,
    name: provider.name || provider.operator || provider.id,
    operator: provider.operator,
    groupId: createMotisRentalId(origin, provider.groupId, "group", provider.groupId),
    url: provider.url,
    purchaseUrl: provider.purchaseUrl,
    color: provider.color || undefined,
    branding: {
      name: provider.name,
      legalName: provider.operator,
      color: provider.color || undefined,
    },
    bbox: provider.bbox,
    formFactors: provider.formFactors.map(mapFormFactor),
    vehicleTypes: provider.vehicleTypes.map((vehicleType) =>
      mapVehicleType(provider.id, origin, vehicleType),
    ),
    defaultRestrictions: mapRestriction(provider.defaultRestrictions, provider, origin),
    globalRestrictions: provider.globalGeofencingRules.map((restriction) =>
      mapRestriction(restriction, provider, origin),
    ),
    sourceId,
    servingOrigin: origin,
  };
}

function decodeMultiPolygon(
  encoded: MultiPolygon,
  warningLabel: string,
  warnings: string[],
): SharedMobilityMultiPolygonGeometry | undefined {
  const coordinates: number[][][][] = [];
  for (const [polygonIndex, polygon] of encoded.entries()) {
    const rings: number[][][] = [];
    let malformed = false;
    for (const [ringIndex, ring] of polygon.entries()) {
      if (ring.precision !== 6) {
        warnings.push(
          `${warningLabel}: polygon ${polygonIndex} ring ${ringIndex} uses precision ${ring.precision}, expected 6`,
        );
        malformed = true;
        break;
      }
      try {
        const decoded = decodePolyline(ring.points, 6);
        if (
          decoded.length < 4 ||
          decoded.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat)) ||
          decoded[0]?.[0] !== decoded.at(-1)?.[0] ||
          decoded[0]?.[1] !== decoded.at(-1)?.[1]
        ) {
          throw new Error("ring is not a finite closed polygon");
        }
        rings.push(decoded.map(([lng, lat]) => [lng, lat]));
      } catch (error) {
        warnings.push(
          `${warningLabel}: polygon ${polygonIndex} ring ${ringIndex} is malformed (${(error as Error).message})`,
        );
        malformed = true;
        break;
      }
    }
    if (!malformed && rings.length > 0) coordinates.push(rings);
  }
  return coordinates.length > 0 ? { type: "MultiPolygon", coordinates } : undefined;
}

function typeLookups(provider: RentalProvider | undefined, origin: RentalServingOrigin) {
  const byNativeId = new Map<
    string,
    { stableId: string; formFactor: VehicleFormFactor; returnConstraint: RentalReturnConstraint }
  >();
  for (const vehicleType of provider?.vehicleTypes ?? []) {
    byNativeId.set(vehicleType.id, {
      stableId: scopedTypeId(origin, provider?.id ?? "unknown", vehicleType.id),
      formFactor: mapFormFactor(vehicleType.formFactor),
      returnConstraint: mapReturnConstraint(vehicleType.returnConstraint),
    });
  }
  return byNativeId;
}

function matchingNativeTypeIds(
  provider: RentalProvider | undefined,
  filters: Set<VehicleFormFactor> | null,
): Set<string> | null {
  if (!filters) return null;
  return new Set(
    (provider?.vehicleTypes ?? [])
      .filter((vehicleType) => filters.has(mapFormFactor(vehicleType.formFactor)))
      .map((vehicleType) => vehicleType.id),
  );
}

function sumMatchingCounts(counts: Record<string, number>, matching: Set<string> | null): number {
  return Object.entries(counts).reduce(
    (sum, [typeId, count]) => (matching === null || matching.has(typeId) ? sum + count : sum),
    0,
  );
}

function stationReturnConstraint(
  typeIds: string[],
  lookup: ReturnType<typeof typeLookups>,
): RentalReturnConstraint | undefined {
  const values = new Set(
    typeIds.map((typeId) => lookup.get(typeId)?.returnConstraint).filter(Boolean),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

function mapStation(
  station: RentalStation,
  provider: RentalProvider | undefined,
  providerGroup: RentalProviderGroup | undefined,
  origin: RentalServingOrigin,
  filters: Set<VehicleFormFactor> | null,
  warnings: string[],
): SharedMobilityStation | null {
  const matching = matchingNativeTypeIds(provider, filters);
  const lookup = typeLookups(provider, origin);
  const availableNativeTypeIds = Object.keys(station.vehicleTypesAvailable).filter(
    (typeId) => matching === null || matching.has(typeId),
  );
  const dockNativeTypeIds = Object.keys(station.vehicleDocksAvailable).filter(
    (typeId) => matching === null || matching.has(typeId),
  );
  const relevantNativeTypeIds = [...new Set([...availableNativeTypeIds, ...dockNativeTypeIds])];
  const stationFormFactors = station.formFactors.map(mapFormFactor);
  const filteredFormFactors = filters
    ? stationFormFactors.filter((formFactor) => filters.has(formFactor))
    : stationFormFactors;
  if (filters && filteredFormFactors.length === 0 && relevantNativeTypeIds.length === 0)
    return null;
  const availableVehicles = sumMatchingCounts(station.vehicleTypesAvailable, matching);
  const emptySlots = sumMatchingCounts(station.vehicleDocksAvailable, matching);
  const hasDockCounts = dockNativeTypeIds.length > 0;
  const sourceId = sourceIdForProvider(station.providerId);
  const primaryScheme = `${origin}/${encodedSegment(station.providerId)}/station`;
  return {
    id: createMotisRentalId(origin, station.providerId, "station", station.id),
    primaryScheme,
    ids: { [primaryScheme]: station.id },
    nativeId: station.id,
    providerId: createMotisRentalId(origin, station.providerId, "provider", station.providerId),
    providerGroupId: createMotisRentalId(
      origin,
      station.providerGroupId,
      "group",
      station.providerGroupId,
    ),
    providerName: provider?.name || provider?.operator || station.providerId,
    providerGroupName: providerGroup?.name,
    providerUrl: provider?.url,
    purchaseUrl: provider?.purchaseUrl,
    servingOrigin: origin,
    systemId: station.providerId,
    name: station.name,
    coordinates: [station.lon, station.lat] satisfies LngLat,
    availableVehicles,
    ...(hasDockCounts ? { emptySlots, capacity: availableVehicles + emptySlots } : {}),
    operator: provider?.name || provider?.operator || station.providerId,
    branding: provider
      ? { name: provider.name, legalName: provider.operator, color: provider.color || undefined }
      : undefined,
    vehicleTypes: filteredFormFactors.length > 0 ? filteredFormFactors : ["other"],
    vehicleTypeIds: relevantNativeTypeIds.map(
      (typeId) => lookup.get(typeId)?.stableId ?? scopedTypeId(origin, station.providerId, typeId),
    ),
    isActive: station.isRenting || station.isReturning,
    isRenting: station.isRenting,
    isReturning: station.isReturning,
    returnConstraint: stationReturnConstraint(relevantNativeTypeIds, lookup),
    sources: [sourceId],
    address: station.address ? { street: station.address } : undefined,
    crossStreet: station.crossStreet,
    website: station.rentalUriWeb,
    rentalUris: {
      web: station.rentalUriWeb,
      android: station.rentalUriAndroid,
      ios: station.rentalUriIOS,
    },
    stationArea: station.stationArea
      ? decodeMultiPolygon(station.stationArea, `station ${station.id} area`, warnings)
      : undefined,
    vehicleTypeDetails: provider?.vehicleTypes.map((type) =>
      mapVehicleType(station.providerId, origin, type),
    ),
  };
}

function mapVehicle(
  vehicle: RentalVehicle,
  provider: RentalProvider | undefined,
  providerGroup: RentalProviderGroup | undefined,
  origin: RentalServingOrigin,
): SharedMobilityVehicle {
  const sourceId = sourceIdForProvider(vehicle.providerId);
  const primaryScheme = `${origin}/${encodedSegment(vehicle.providerId)}/vehicle`;
  return {
    id: createMotisRentalId(origin, vehicle.providerId, "vehicle", vehicle.id),
    primaryScheme,
    ids: { [primaryScheme]: vehicle.id },
    nativeId: vehicle.id,
    providerId: createMotisRentalId(origin, vehicle.providerId, "provider", vehicle.providerId),
    providerGroupId: createMotisRentalId(
      origin,
      vehicle.providerGroupId,
      "group",
      vehicle.providerGroupId,
    ),
    providerName: provider?.name || provider?.operator || vehicle.providerId,
    providerGroupName: providerGroup?.name,
    providerUrl: provider?.url,
    purchaseUrl: provider?.purchaseUrl,
    servingOrigin: origin,
    systemId: vehicle.providerId,
    coordinates: [vehicle.lon, vehicle.lat] satisfies LngLat,
    formFactor: mapFormFactor(vehicle.formFactor),
    propulsion: mapPropulsion(vehicle.propulsionType),
    vehicleTypeId: scopedTypeId(origin, vehicle.providerId, vehicle.typeId),
    returnConstraint: mapReturnConstraint(vehicle.returnConstraint),
    stationId: vehicle.stationId
      ? createMotisRentalId(origin, vehicle.providerId, "station", vehicle.stationId)
      : undefined,
    homeStationId: vehicle.homeStationId
      ? createMotisRentalId(origin, vehicle.providerId, "station", vehicle.homeStationId)
      : undefined,
    isReserved: vehicle.isReserved,
    isDisabled: vehicle.isDisabled,
    operator: provider?.name || provider?.operator || vehicle.providerId,
    branding: provider
      ? { name: provider.name, legalName: provider.operator, color: provider.color || undefined }
      : undefined,
    rentalUris: {
      web: vehicle.rentalUriWeb,
      android: vehicle.rentalUriAndroid,
      ios: vehicle.rentalUriIOS,
    },
    sources: [sourceId],
  };
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function mapZone(
  zone: RentalZone,
  provider: RentalProvider,
  origin: RentalServingOrigin,
  warnings: string[],
): SharedMobilityZone | null {
  const rules = zone.rules.map((rule) => mapRestriction(rule, provider, origin));
  const area = decodeMultiPolygon(zone.area, `zone ${zone.name ?? "unnamed"}`, warnings);
  if (!area) return null;
  const nativeId = `zone-${stableHash(
    JSON.stringify([zone.providerId, zone.name, zone.z, zone.bbox, area, rules]),
  )}`;
  return {
    id: createMotisRentalId(origin, zone.providerId, "zone", nativeId),
    providerId: createMotisRentalId(origin, zone.providerId, "provider", zone.providerId),
    providerGroupId: createMotisRentalId(
      origin,
      zone.providerGroupId,
      "group",
      zone.providerGroupId,
    ),
    name: zone.name,
    z: zone.z,
    bbox: zone.bbox,
    area,
    rules,
    sourceId: sourceIdForProvider(zone.providerId),
    servingOrigin: origin,
  };
}

export function mapMotisRentalSnapshot(
  response: RentalsResponse,
  origin: RentalServingOrigin,
  formFactors?: VehicleFormFactor[],
): MotisRentalSnapshot {
  const warnings: string[] = [];
  const filters = formFactors && formFactors.length > 0 ? new Set(formFactors) : null;
  const rawProviders = response.providers ?? [];
  const providerById = new Map(rawProviders.map((provider) => [provider.id, provider]));
  const providerGroupById = new Map(
    (response.providerGroups ?? []).map((group) => [group.id, group]),
  );
  const providers = rawProviders
    .filter(
      (provider) =>
        !filters || provider.formFactors.some((factor) => filters.has(mapFormFactor(factor))),
    )
    .map((provider) => mapProvider(provider, origin));
  const includedProviderNativeIds = new Set(providers.map((provider) => provider.nativeId));
  const providerGroups = (response.providerGroups ?? [])
    .map((group) => ({
      ...group,
      providers: group.providers.filter((providerId) => includedProviderNativeIds.has(providerId)),
      formFactors: filters
        ? group.formFactors.filter((factor) => filters.has(mapFormFactor(factor)))
        : group.formFactors,
    }))
    .filter((group) => group.providers.length > 0 || group.formFactors.length > 0)
    .map((group) => mapProviderGroup(group, origin));
  const stations = (response.stations ?? [])
    .map((station) =>
      mapStation(
        station,
        providerById.get(station.providerId),
        providerGroupById.get(station.providerGroupId),
        origin,
        filters,
        warnings,
      ),
    )
    .filter((station): station is SharedMobilityStation => station !== null);
  const vehicles = (response.vehicles ?? [])
    .filter((vehicle) => !vehicle.isReserved && !vehicle.isDisabled)
    .filter((vehicle) => !filters || filters.has(mapFormFactor(vehicle.formFactor)))
    .map((vehicle) =>
      mapVehicle(
        vehicle,
        providerById.get(vehicle.providerId),
        providerGroupById.get(vehicle.providerGroupId),
        origin,
      ),
    );
  const zones = (response.zones ?? [])
    .flatMap((zone) => {
      const provider = providerById.get(zone.providerId);
      if (!provider) {
        warnings.push(
          `zone ${zone.name ?? "unnamed"} references missing provider ${zone.providerId}`,
        );
        return [];
      }
      if (!includedProviderNativeIds.has(provider.id)) return [];
      const mapped = mapZone(zone, provider, origin, warnings);
      return mapped ? [mapped] : [];
    })
    .sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
  return {
    origin,
    providers,
    providerGroups,
    stations,
    vehicles,
    zones,
    completeness: {
      providers: true,
      providerGroups: true,
      stations: true,
      vehicles: true,
      zones: warnings.every((warning) => !warning.startsWith("zone ")),
      warnings,
    },
  };
}

function emptySnapshot(origin: RentalServingOrigin, warning: string): MotisRentalSnapshot {
  return {
    origin,
    providers: [],
    providerGroups: [],
    stations: [],
    vehicles: [],
    zones: [],
    completeness: {
      providers: false,
      providerGroups: false,
      stations: false,
      vehicles: false,
      zones: false,
      warnings: [warning],
    },
  };
}

interface RentalQueryOutcome {
  data?: RentalsResponse;
  fallbackEligible: boolean;
  failure?: string;
}

async function queryRentals(
  instance: MotisInstance,
  bbox: [number, number, number, number],
): Promise<RentalQueryOutcome> {
  const [west, south, east, north] = bbox;
  try {
    const response = await rentals({
      client: instance.client,
      fetch: globalThis.fetch,
      query: {
        min: `${south},${west}`,
        max: `${north},${east}`,
        withProviders: true,
        withStations: true,
        withVehicles: true,
        withZones: true,
      },
    });
    if (response.data) return { data: response.data, fallbackEligible: false };
    const status = response.response?.status ?? 0;
    return {
      fallbackEligible: status === 0 || status >= 500,
      failure: status > 0 ? `HTTP ${status}` : "MOTIS rental request failed",
    };
  } catch (error) {
    return { fallbackEligible: true, failure: (error as Error).message };
  }
}

export async function fetchMotisRentals(
  bbox: [number, number, number, number],
  formFactors?: VehicleFormFactor[],
): Promise<MotisRentalSnapshot> {
  const now = Date.now();
  if (now >= localBreakerOpenUntil) {
    const local = await queryRentals(motisLocalInstance, bbox);
    if (local.data) {
      localFailures = 0;
      localBreakerOpenUntil = 0;
      return mapMotisRentalSnapshot(local.data, "motis-local", formFactors);
    }
    if (!local.fallbackEligible) {
      return emptySnapshot("motis-local", local.failure ?? "local MOTIS rejected rentals request");
    }
    localFailures++;
    if (localFailures >= LOCAL_BREAKER_FAILURES) {
      localBreakerOpenUntil = now + LOCAL_BREAKER_OPEN_MS;
    }
  }

  const hosted = await queryRentals(transitousInstance, bbox);
  if (hosted.data) return mapMotisRentalSnapshot(hosted.data, "transitous", formFactors);
  return emptySnapshot("transitous", hosted.failure ?? "hosted Transitous rentals unavailable");
}
