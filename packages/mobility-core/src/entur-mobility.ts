import { createHash } from "node:crypto";
import { type CacheClient, TTL, withCache } from "./cache.js";
import { isEnturGbfsUrl } from "./entur-gbfs.js";
import {
  filterCatalogByBbox,
  type GbfsCatalogClient,
  normalizeFormFactor,
} from "./gbfs-catalog.js";
import type { MobilityHttpTransport } from "./json-transport.js";
import {
  applicableMobilityRules,
  classifyMobilityRules,
  normalizeAndClipMobilityGeometry,
} from "./mobility-context-geometry.js";
import { normalizeRentalReturnConstraint } from "./rental-constraints.js";
import type { BoundingBox } from "./types/geometry.js";
import type {
  PricingDetail,
  SharedMobilityAreaGeometry,
  SharedMobilityBranding,
  SharedMobilityRentalApps,
  SharedMobilityStation,
  SharedMobilityVehicle,
  VehicleTypeDetail,
} from "./types/shared-mobility.js";

function normalizeAreaGeometry(
  geometry: EnturStation["stationArea"],
): SharedMobilityAreaGeometry | undefined {
  if (!geometry || !Array.isArray(geometry.coordinates)) return undefined;
  const isPosition = (value: unknown): value is number[] =>
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]);
  const isRing = (value: unknown): value is number[][] =>
    Array.isArray(value) && value.length >= 4 && value.every(isPosition);
  const isPolygon = (value: unknown): value is number[][][] =>
    Array.isArray(value) && value.length > 0 && value.every(isRing);
  if (geometry.type === "Polygon" && isPolygon(geometry.coordinates)) {
    return { type: "Polygon", coordinates: geometry.coordinates };
  }
  if (
    geometry.type === "MultiPolygon" &&
    geometry.coordinates.length > 0 &&
    geometry.coordinates.every(isPolygon)
  ) {
    return { type: "MultiPolygon", coordinates: geometry.coordinates as number[][][][] };
  }
  return undefined;
}

const ENTUR_CLIENT_NAME = "openmapx-server";
const ENTUR_GRAPHQL_URL = "https://api.entur.io/mobility/v2/graphql";
const ENTUR_QUERY_CACHE_TTL = TTL.sharedMobility.stations;
const DEFAULT_SLOW_ZONE_KPH = 20;
const ENGLISH_LANGS = new Set(["en", "eng"]);
const NORWEGIAN_LANGS = new Set(["no", "nor", "nob", "nno", "nb", "nn"]);

export { isEnturGbfsUrl } from "./entur-gbfs.js";

interface EnturTranslatedString {
  translation?: Array<{ language?: string | null; value?: string | null } | null> | null;
}

interface EnturBrandAssets {
  brandImageUrl?: string | null;
  brandImageUrlDark?: string | null;
  color?: string | null;
}

interface EnturRentalApp {
  storeUri?: string | null;
  discoveryUri?: string | null;
}

interface EnturRentalApps {
  ios?: EnturRentalApp | null;
  android?: EnturRentalApp | null;
}

interface EnturPricingSegment {
  rate?: number | null;
  interval?: number | null;
}

interface EnturPricingPlan {
  name?: EnturTranslatedString | null;
  description?: EnturTranslatedString | null;
  currency?: string | null;
  price?: number | null;
  perKmPricing?: EnturPricingSegment[] | null;
  perMinPricing?: EnturPricingSegment[] | null;
}

interface EnturVehicleAssets {
  iconUrl?: string | null;
  iconUrlDark?: string | null;
}

interface EnturVehicleType {
  id: string;
  formFactor?: string | null;
  name?: EnturTranslatedString | null;
  description?: EnturTranslatedString | null;
  make?: string | null;
  model?: string | null;
  color?: string | null;
  propulsionType?: string | null;
  riderCapacity?: number | null;
  vehicleAccessories?: Array<string | null> | null;
  gCO2km?: number | null;
  returnConstraint?: string | null;
  vehicleImage?: string | null;
  vehicleAssets?: EnturVehicleAssets | null;
  defaultPricingPlan?: EnturPricingPlan | null;
  pricingPlans?: Array<EnturPricingPlan | null> | null;
}

interface EnturSystem {
  id: string;
  name?: EnturTranslatedString | null;
  operator?: { name?: EnturTranslatedString | null } | null;
  url?: string | null;
  purchaseUrl?: string | null;
  brandAssets?: EnturBrandAssets | null;
  rentalApps?: EnturRentalApps | null;
}

interface EnturStation {
  id: string;
  address?: string | null;
  postCode?: string | null;
  region?: { name?: string | null } | null;
  rentalMethods?: Array<string | null> | null;
  isVirtualStation?: boolean | null;
  stationArea?: { type: "Polygon" | "MultiPolygon"; coordinates: unknown } | null;
  rentalUris?: { web?: string | null; ios?: string | null; android?: string | null } | null;
  pricingPlans?: Array<EnturPricingPlan | null> | null;
  system: EnturSystem;
  vehicleTypesAvailable?: Array<{
    count?: number | null;
    vehicleType: EnturVehicleType;
  } | null> | null;
}

interface EnturVehicle {
  id: string;
  currentFuelPercent?: number | null;
  currentRangeMeters?: number | null;
  rentalUris?: { web?: string | null; ios?: string | null; android?: string | null } | null;
  system: EnturSystem;
  vehicleType: EnturVehicleType;
}

interface EnturGeofencingRule {
  vehicleTypeIds?: string[] | null;
  rideStartAllowed: boolean;
  rideEndAllowed: boolean;
  rideThroughAllowed: boolean;
  maximumSpeedKph?: number | null;
  stationParking?: boolean | null;
}

interface EnturGeofencingFeature {
  type: "Feature";
  geometry?: { type: "Polygon" | "MultiPolygon"; coordinates: unknown } | null;
  properties?: {
    name?: string | null;
    rules?: Array<EnturGeofencingRule | null> | null;
  } | null;
}

interface EnturGeofencingZones {
  systemId?: string | null;
  geojson?: {
    type: "FeatureCollection";
    features?: Array<EnturGeofencingFeature | null> | null;
  } | null;
}

export interface SharedMobilityMapContext {
  geojson: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      geometry:
        | { type: "Polygon"; coordinates: number[][][] }
        | { type: "MultiPolygon"; coordinates: number[][][][] };
      properties: Record<string, unknown> | null;
    }>;
  };
}

interface EnturEnrichmentData {
  stations?: EnturStation[] | null;
  vehicles?: EnturVehicle[] | null;
}

export interface EnturMobilityDependencies {
  cache: CacheClient;
  catalog: GbfsCatalogClient;
  transport: MobilityHttpTransport;
}

function hashParts(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

async function fetchEnturGraphQl<T>(
  dependencies: EnturMobilityDependencies,
  query: string,
  variables: Record<string, unknown>,
  cacheKey: string,
): Promise<T> {
  return withCache(dependencies.cache, cacheKey, ENTUR_QUERY_CACHE_TTL, async () => {
    const json = await dependencies.transport.fetchJson<{
      data?: T;
      errors?: Array<{ message?: string }>;
    }>(ENTUR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "User-Agent": dependencies.transport.userAgent,
        "content-type": "application/json",
        "ET-Client-Name": ENTUR_CLIENT_NAME,
      },
      body: JSON.stringify({ query, variables }),
      timeoutMs: 10_000,
      maxBytes: 8 * 1024 * 1024,
    });
    if (json.errors?.length) {
      throw new Error(
        json.errors
          .map((error) => error.message)
          .filter(Boolean)
          .join("; ") || "Entur mobility GraphQL returned errors",
      );
    }
    if (!json.data) {
      throw new Error("Entur mobility GraphQL returned no data");
    }
    return json.data;
  });
}

function pickTranslatedString(value: EnturTranslatedString | null | undefined): string | undefined {
  const translations = value?.translation?.filter(
    (entry): entry is { language?: string | null; value?: string | null } => !!entry,
  );
  if (!translations || translations.length === 0) return undefined;

  for (const entry of translations) {
    if (entry.language && ENGLISH_LANGS.has(entry.language.toLowerCase()) && entry.value) {
      return entry.value;
    }
  }
  for (const entry of translations) {
    if (entry.language && NORWEGIAN_LANGS.has(entry.language.toLowerCase()) && entry.value) {
      return entry.value;
    }
  }
  return translations.map((entry) => entry.value).find((text): text is string => !!text);
}

function normalizeAccessory(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.toLowerCase();
}

function normalizePropulsion(
  value: string | null | undefined,
): SharedMobilityVehicle["propulsion"] {
  switch ((value ?? "").toLowerCase()) {
    case "human":
      return "human";
    case "electric_assist":
      return "electric_assist";
    case "electric":
      return "electric";
    case "combustion":
      return "combustion";
    case "combustion_diesel":
      return "combustion_diesel";
    case "hybrid":
      return "hybrid";
    case "plug_in_hybrid":
      return "plug_in_hybrid";
    case "hydrogen_fuel_cell":
      return "hydrogen_fuel_cell";
    default:
      return undefined;
  }
}

function mapRentalApps(
  apps: EnturRentalApps | null | undefined,
): SharedMobilityRentalApps | undefined {
  if (!apps?.ios && !apps?.android) return undefined;
  return {
    ios: apps.ios
      ? {
          storeUri: apps.ios.storeUri ?? undefined,
          discoveryUri: apps.ios.discoveryUri ?? undefined,
        }
      : undefined,
    android: apps.android
      ? {
          storeUri: apps.android.storeUri ?? undefined,
          discoveryUri: apps.android.discoveryUri ?? undefined,
        }
      : undefined,
  };
}

function mapBranding(system: EnturSystem): SharedMobilityBranding | undefined {
  const name = pickTranslatedString(system.name);
  const legalName = pickTranslatedString(system.operator?.name);
  const logoUrl = system.brandAssets?.brandImageUrl ?? undefined;
  const logoUrlDark = system.brandAssets?.brandImageUrlDark ?? undefined;
  const color = system.brandAssets?.color ?? undefined;

  if (!name && !legalName && !logoUrl && !logoUrlDark && !color) return undefined;

  return {
    name,
    legalName,
    logoUrl,
    logoUrlDark,
    color,
  };
}

function mergeBranding(
  current: SharedMobilityBranding | undefined,
  incoming: SharedMobilityBranding | undefined,
): SharedMobilityBranding | undefined {
  if (!current && !incoming) return undefined;
  return {
    name: incoming?.name ?? current?.name,
    legalName: incoming?.legalName ?? current?.legalName,
    logoUrl: incoming?.logoUrl ?? current?.logoUrl,
    logoUrlDark: incoming?.logoUrlDark ?? current?.logoUrlDark,
    color: incoming?.color ?? current?.color,
  };
}

function mapPricingPlan(plan: EnturPricingPlan | null | undefined): PricingDetail | null {
  if (!plan) return null;
  const perKmRate = plan.perKmPricing?.[0]?.rate ?? undefined;
  const perMinute = plan.perMinPricing?.[0];
  const perHourRate =
    perMinute?.rate != null && perMinute.interval
      ? (perMinute.rate / perMinute.interval) * 60
      : undefined;
  return {
    name: pickTranslatedString(plan.name) ?? "",
    description: pickTranslatedString(plan.description),
    currency: plan.currency ?? "NOK",
    perKmRate,
    perHourRate: perHourRate && perHourRate > 0 ? perHourRate : undefined,
    flatRate: plan.price && plan.price > 0 ? plan.price : undefined,
  };
}

function mapVehicleTypeDetail(vehicleType: EnturVehicleType): VehicleTypeDetail {
  return {
    id: vehicleType.id,
    name:
      pickTranslatedString(vehicleType.name) ??
      ([vehicleType.make, vehicleType.model].filter(Boolean).join(" ") || "Vehicle"),
    formFactor: normalizeFormFactor((vehicleType.formFactor ?? "").toLowerCase()),
    make: vehicleType.make ?? undefined,
    model: vehicleType.model ?? undefined,
    propulsion: normalizePropulsion(vehicleType.propulsionType),
    accessories: (vehicleType.vehicleAccessories ?? [])
      .map((value) => normalizeAccessory(value ?? undefined))
      .filter((value): value is string => !!value),
    co2PerKm: vehicleType.gCO2km ?? undefined,
    riderCapacity: vehicleType.riderCapacity ?? undefined,
    returnConstraint: normalizeRentalReturnConstraint(vehicleType.returnConstraint),
    imageUrl: vehicleType.vehicleImage ?? undefined,
    iconUrl: vehicleType.vehicleAssets?.iconUrl ?? undefined,
    iconUrlDark: vehicleType.vehicleAssets?.iconUrlDark ?? undefined,
    color: vehicleType.color ?? undefined,
  };
}

function pricingSummary(details: PricingDetail[] | undefined): string | undefined {
  if (!details || details.length === 0) return undefined;
  let cheapestUnlock: { amount: number; currency: string } | undefined;
  let cheapestPerKm: { amount: number; currency: string } | undefined;
  let cheapestPerHour: { amount: number; currency: string } | undefined;

  for (const detail of details) {
    if (
      detail.flatRate !== undefined &&
      (cheapestUnlock === undefined || detail.flatRate < cheapestUnlock.amount)
    ) {
      cheapestUnlock = { amount: detail.flatRate, currency: detail.currency };
    }
    if (
      detail.perKmRate !== undefined &&
      (cheapestPerKm === undefined || detail.perKmRate < cheapestPerKm.amount)
    ) {
      cheapestPerKm = { amount: detail.perKmRate, currency: detail.currency };
    }
    if (
      detail.perHourRate !== undefined &&
      (cheapestPerHour === undefined || detail.perHourRate < cheapestPerHour.amount)
    ) {
      cheapestPerHour = { amount: detail.perHourRate, currency: detail.currency };
    }
  }

  const parts: string[] = [];
  if (cheapestUnlock !== undefined) {
    parts.push(`${cheapestUnlock.amount.toFixed(2)} ${cheapestUnlock.currency}`);
  }
  if (cheapestPerKm !== undefined) {
    parts.push(`${cheapestPerKm.amount.toFixed(2)} ${cheapestPerKm.currency}/km`);
  }
  if (cheapestPerHour !== undefined) {
    parts.push(`${cheapestPerHour.amount.toFixed(2)} ${cheapestPerHour.currency}/h`);
  }
  return parts.length > 0 ? parts.join(" + ") : undefined;
}

function pricingDetailKey(detail: PricingDetail): string {
  return [
    detail.name.trim().toLowerCase(),
    detail.description?.trim().toLowerCase() ?? "",
    detail.currency,
    detail.flatRate?.toFixed(6) ?? "",
    detail.perKmRate?.toFixed(6) ?? "",
    detail.perHourRate?.toFixed(6) ?? "",
  ].join("|");
}

function mergePricingDetails(
  current: PricingDetail[] | undefined,
  incoming: PricingDetail[],
): PricingDetail[] | undefined {
  if (incoming.length === 0) return current;
  if (!current || current.length === 0) return incoming;

  const merged = new Map<string, PricingDetail>();

  for (const detail of current) {
    merged.set(pricingDetailKey(detail), detail);
  }

  for (const detail of incoming) {
    const key = pricingDetailKey(detail);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, detail);
      continue;
    }
    merged.set(key, {
      ...detail,
      ...existing,
      name: existing.name || detail.name,
      description: existing.description ?? detail.description,
      currency: existing.currency || detail.currency,
      flatRate: existing.flatRate ?? detail.flatRate,
      perKmRate: existing.perKmRate ?? detail.perKmRate,
      perHourRate: existing.perHourRate ?? detail.perHourRate,
    });
  }

  return [...merged.values()];
}

function mergeVehicleTypeDetails(
  current: VehicleTypeDetail[] | undefined,
  incoming: VehicleTypeDetail[],
): VehicleTypeDetail[] {
  if (incoming.length === 0) return current ?? [];
  if (!current || current.length === 0) return incoming;

  const merged = new Map<string, VehicleTypeDetail>();

  const keyFor = (detail: VehicleTypeDetail): string =>
    detail.id ??
    `${detail.formFactor ?? "other"}:${detail.make ?? ""}:${detail.model ?? ""}:${detail.name}`;

  for (const detail of current) {
    merged.set(keyFor(detail), detail);
  }

  for (const detail of incoming) {
    const key = keyFor(detail);
    const existing = merged.get(key);
    merged.set(key, {
      ...detail,
      ...existing,
      id: detail.id ?? existing?.id,
      name: detail.name || existing?.name || "Vehicle",
      formFactor: detail.formFactor ?? existing?.formFactor,
      make: detail.make ?? existing?.make,
      model: detail.model ?? existing?.model,
      propulsion: detail.propulsion ?? existing?.propulsion,
      accessories: detail.accessories ?? existing?.accessories,
      co2PerKm: detail.co2PerKm ?? existing?.co2PerKm,
      riderCapacity: detail.riderCapacity ?? existing?.riderCapacity,
      returnConstraint: detail.returnConstraint ?? existing?.returnConstraint,
      imageUrl: detail.imageUrl ?? existing?.imageUrl,
      iconUrl: detail.iconUrl ?? existing?.iconUrl,
      iconUrlDark: detail.iconUrlDark ?? existing?.iconUrlDark,
      color: detail.color ?? existing?.color,
    });
  }

  return [...merged.values()];
}

function mapRentalMethods(methods: Array<string | null> | null | undefined): string | undefined {
  if (!methods || methods.length === 0) return undefined;
  const labels = methods
    .map((method) => {
      switch (method) {
        case "PHONE":
          return "Phone";
        case "TRANSITCARD":
          return "Transit Card";
        case "APPLEPAY":
        case "APPLEPLAY":
          return "Apple Pay";
        case "ANDROIDPAY":
          return "Google Pay";
        case "ACCOUNTNUMBER":
          return "Account";
        case "CREDITCARD":
          return "Card";
        case "PAYPASS":
          return "PayPass";
        case "KEY":
          return "Key";
        default:
          return method ? method.toLowerCase().replace(/_/g, " ") : undefined;
      }
    })
    .filter((label): label is string => !!label);

  return labels.length > 0 ? labels.join(", ") : undefined;
}

async function loadEnturSystemIds(dependencies: EnturMobilityDependencies): Promise<Set<string>> {
  const catalog = await dependencies.catalog.loadCatalog();
  return new Set(
    catalog
      .filter((entry) => isEnturGbfsUrl(entry.autoDiscoveryUrl))
      .map((entry) => entry.systemId),
  );
}

export async function enrichEnturMobilityItems(
  stations: SharedMobilityStation[],
  vehicles: SharedMobilityVehicle[],
  options: EnturMobilityDependencies & { scope?: "map" | "detail" },
): Promise<void> {
  const enturSystemIds = await loadEnturSystemIds(options);

  const stationIds = [
    ...new Set(
      stations
        .filter(
          (station) => station.systemId && station.nativeId && enturSystemIds.has(station.systemId),
        )
        .map((station) => station.nativeId as string),
    ),
  ];
  const vehicleIds = [
    ...new Set(
      vehicles
        .filter(
          (vehicle) => vehicle.systemId && vehicle.nativeId && enturSystemIds.has(vehicle.systemId),
        )
        .map((vehicle) => vehicle.nativeId as string),
    ),
  ];

  if (stationIds.length === 0 && vehicleIds.length === 0) return;

  const detailStationFields =
    options.scope === "map"
      ? ""
      : `
        pricingPlans {
          name { translation { language value } }
          description { translation { language value } }
          currency price
          perKmPricing { rate interval }
          perMinPricing { rate interval }
        }
        vehicleTypesAvailable {
          count
          vehicleType {
            id formFactor name { translation { language value } }
            description { translation { language value } }
            make model color propulsionType riderCapacity vehicleAccessories gCO2km
            returnConstraint vehicleImage vehicleAssets { iconUrl iconUrlDark }
            defaultPricingPlan {
              name { translation { language value } }
              description { translation { language value } }
              currency price perKmPricing { rate interval } perMinPricing { rate interval }
            }
            pricingPlans {
              name { translation { language value } }
              description { translation { language value } }
              currency price perKmPricing { rate interval } perMinPricing { rate interval }
            }
          }
        }`;
  const vehicleTypeFields =
    options.scope === "map"
      ? "id propulsionType vehicleImage vehicleAssets { iconUrl iconUrlDark }"
      : `
          id formFactor name { translation { language value } }
          description { translation { language value } }
          make model color propulsionType riderCapacity vehicleAccessories gCO2km
          returnConstraint vehicleImage vehicleAssets { iconUrl iconUrlDark }
          defaultPricingPlan {
            name { translation { language value } }
            description { translation { language value } }
            currency price perKmPricing { rate interval } perMinPricing { rate interval }
          }
          pricingPlans {
            name { translation { language value } }
            description { translation { language value } }
            currency price perKmPricing { rate interval } perMinPricing { rate interval }
          }`;
  const query = `
    query EnturMobilityEnrichment($stationIds: [String!], $vehicleIds: [String!]) {
      stations(ids: $stationIds) {
        id
        address
        postCode
        region { name }
        rentalMethods
        isVirtualStation
        stationArea { type coordinates }
        rentalUris { web ios android }
        ${detailStationFields}
        system {
          id
          url
          purchaseUrl
          name { translation { language value } }
          operator { name { translation { language value } } }
          brandAssets { brandImageUrl brandImageUrlDark color }
          rentalApps {
            ios { storeUri discoveryUri }
            android { storeUri discoveryUri }
          }
        }
      }
      vehicles(ids: $vehicleIds) {
        id
        currentFuelPercent
        currentRangeMeters
        rentalUris { web ios android }
        system {
          id
          url
          purchaseUrl
          name { translation { language value } }
          operator { name { translation { language value } } }
          brandAssets { brandImageUrl brandImageUrlDark color }
          rentalApps {
            ios { storeUri discoveryUri }
            android { storeUri discoveryUri }
          }
        }
        vehicleType {
          ${vehicleTypeFields}
        }
      }
    }
  `;

  const data = await fetchEnturGraphQl<EnturEnrichmentData>(
    options,
    query,
    { stationIds, vehicleIds },
    `shared-mobility:entur:items:${options.scope ?? "detail"}:${hashParts([
      ...stationIds.sort(),
      ...vehicleIds.sort(),
    ])}`,
  );

  const stationById = new Map((data.stations ?? []).map((station) => [station.id, station]));
  const vehicleById = new Map((data.vehicles ?? []).map((vehicle) => [vehicle.id, vehicle]));

  for (const station of stations) {
    const nativeId = station.nativeId;
    if (!nativeId) continue;
    const enturStation = stationById.get(nativeId);
    if (!enturStation) continue;

    const branding = mapBranding(enturStation.system);
    const details = [
      ...(enturStation.pricingPlans ?? [])
        .map((plan) => mapPricingPlan(plan))
        .filter((plan): plan is PricingDetail => !!plan),
      ...(enturStation.vehicleTypesAvailable ?? []).flatMap((entry) => {
        const vehicleType = entry?.vehicleType;
        if (!vehicleType) return [];
        return [
          mapPricingPlan(vehicleType.defaultPricingPlan),
          ...(vehicleType.pricingPlans ?? []).map((plan) => mapPricingPlan(plan)),
        ].filter((plan): plan is PricingDetail => !!plan);
      }),
    ];
    const vehicleTypeDetails = (enturStation.vehicleTypesAvailable ?? [])
      .map((entry) => entry?.vehicleType)
      .filter((vehicleType): vehicleType is EnturVehicleType => !!vehicleType)
      .map((vehicleType) => mapVehicleTypeDetail(vehicleType));

    station.systemId = station.systemId ?? enturStation.system.id;
    station.nativeId = station.nativeId ?? enturStation.id;
    station.operator =
      branding?.name ?? station.operator ?? pickTranslatedString(enturStation.system.name);
    station.branding = mergeBranding(station.branding, branding);
    station.website =
      station.website ?? enturStation.system.purchaseUrl ?? enturStation.system.url ?? undefined;
    station.rentalApps = station.rentalApps ?? mapRentalApps(enturStation.system.rentalApps);
    station.rentalUris = station.rentalUris ?? {
      web: enturStation.rentalUris?.web ?? undefined,
      ios: enturStation.rentalUris?.ios ?? undefined,
      android: enturStation.rentalUris?.android ?? undefined,
    };
    station.stationType = station.stationType ?? (enturStation.isVirtualStation ? "free" : "fixed");
    station.stationArea = station.stationArea ?? normalizeAreaGeometry(enturStation.stationArea);
    station.accessMethod = station.accessMethod ?? mapRentalMethods(enturStation.rentalMethods);
    station.address = station.address ?? {
      street: enturStation.address ?? undefined,
      city: enturStation.region?.name ?? undefined,
      postcode: enturStation.postCode ?? undefined,
    };
    station.vehicleTypeIds =
      station.vehicleTypeIds ??
      vehicleTypeDetails.map((detail) => detail.id).filter((id): id is string => !!id);
    if (vehicleTypeDetails.length > 0) {
      station.vehicleTypeDetails = mergeVehicleTypeDetails(
        station.vehicleTypeDetails,
        vehicleTypeDetails,
      );
    }
    if (details.length > 0) {
      station.pricingDetails = mergePricingDetails(station.pricingDetails, details);
      station.pricingSummary =
        station.pricingSummary ?? pricingSummary(station.pricingDetails ?? details);
    }
  }

  for (const vehicle of vehicles) {
    const nativeId = vehicle.nativeId;
    if (!nativeId) continue;
    const enturVehicle = vehicleById.get(nativeId);
    if (!enturVehicle) continue;

    const branding = mapBranding(enturVehicle.system);
    const vehicleType = enturVehicle.vehicleType;

    vehicle.systemId = vehicle.systemId ?? enturVehicle.system.id;
    vehicle.nativeId = vehicle.nativeId ?? enturVehicle.id;
    vehicle.vehicleTypeId = vehicle.vehicleTypeId ?? vehicleType.id;
    vehicle.operator =
      branding?.name ?? vehicle.operator ?? pickTranslatedString(enturVehicle.system.name);
    vehicle.branding = mergeBranding(vehicle.branding, branding);
    vehicle.batteryLevel =
      vehicle.batteryLevel ??
      (enturVehicle.currentFuelPercent != null
        ? Math.round(
            enturVehicle.currentFuelPercent <= 1
              ? enturVehicle.currentFuelPercent * 100
              : enturVehicle.currentFuelPercent,
          )
        : undefined);
    vehicle.rangeMeters = vehicle.rangeMeters ?? enturVehicle.currentRangeMeters ?? undefined;
    vehicle.propulsion =
      vehicle.propulsion ?? normalizePropulsion(vehicleType.propulsionType) ?? vehicle.propulsion;
    vehicle.vehicleImageUrl = vehicle.vehicleImageUrl ?? vehicleType.vehicleImage ?? undefined;
    vehicle.vehicleIconUrl =
      vehicle.vehicleIconUrl ?? vehicleType.vehicleAssets?.iconUrl ?? undefined;
    vehicle.vehicleIconUrlDark =
      vehicle.vehicleIconUrlDark ?? vehicleType.vehicleAssets?.iconUrlDark ?? undefined;
    vehicle.rentalUris = vehicle.rentalUris ?? {
      web: enturVehicle.rentalUris?.web ?? undefined,
      ios: enturVehicle.rentalUris?.ios ?? undefined,
      android: enturVehicle.rentalUris?.android ?? undefined,
    };
    vehicle.rentalApps = vehicle.rentalApps ?? mapRentalApps(enturVehicle.system.rentalApps);
  }
}

async function fetchEnturGeofencing(
  dependencies: EnturMobilityDependencies,
  systemIds: string[],
): Promise<EnturGeofencingZones[]> {
  if (systemIds.length === 0) return [];

  const query = `
    query EnturGeofencing($systemIds: [ID]) {
      geofencingZones(systemIds: $systemIds) {
        systemId
        geojson {
          type
          features {
            type
            geometry { type coordinates }
            properties {
              name
              rules {
                vehicleTypeIds
                rideStartAllowed
                rideEndAllowed
                rideThroughAllowed
                maximumSpeedKph
                stationParking
              }
            }
          }
        }
      }
    }
  `;

  const data = await fetchEnturGraphQl<{ geofencingZones?: EnturGeofencingZones[] | null }>(
    dependencies,
    query,
    { systemIds },
    `shared-mobility:entur:geofencing:${hashParts(systemIds.slice().sort())}`,
  );

  return data.geofencingZones ?? [];
}

async function resolveEnturGeofencingSystemIds(
  bbox: BoundingBox,
  systemIds: string[] | undefined,
  dependencies: EnturMobilityDependencies,
): Promise<string[]> {
  const catalog = await dependencies.catalog.loadCatalog();
  const enturSystemIds = new Set(
    catalog
      .filter((entry) => isEnturGbfsUrl(entry.autoDiscoveryUrl))
      .map((entry) => entry.systemId)
      .filter((systemId) => systemId.length > 0),
  );

  const explicit = [...new Set(systemIds ?? [])].sort();
  if (explicit.length > 0) {
    // Only forward IDs that are actually hosted on Entur — otherwise the
    // GraphQL endpoint rejects the unknown systemIds and the whole map
    // context call fails.
    return explicit.filter((id) => enturSystemIds.has(id));
  }

  return [
    ...new Set(
      filterCatalogByBbox(catalog, bbox)
        .filter((entry) => isEnturGbfsUrl(entry.autoDiscoveryUrl))
        .map((entry) => entry.systemId)
        .filter((systemId) => systemId.length > 0),
    ),
  ].sort();
}

export async function buildEnturGeofencingMapContext(
  bbox: BoundingBox,
  options: {
    cache: CacheClient;
    catalog: GbfsCatalogClient;
    transport: MobilityHttpTransport;
    systemIds?: string[];
    vehicleTypeIds?: string[];
  },
): Promise<SharedMobilityMapContext | null> {
  const systemIds = await resolveEnturGeofencingSystemIds(bbox, options.systemIds, options);
  if (systemIds.length === 0) return null;

  const geofencing = await fetchEnturGeofencing(options, systemIds);
  const vehicleTypeIds = new Set(options.vehicleTypeIds ?? []);
  const features: SharedMobilityMapContext["geojson"]["features"] = [];

  for (const system of geofencing) {
    const systemId = system.systemId ?? undefined;
    for (const feature of system.geojson?.features ?? []) {
      if (!feature?.geometry) continue;
      const clippedGeometry = normalizeAndClipMobilityGeometry(feature.geometry, bbox);
      if (!clippedGeometry) continue;
      const rules = applicableMobilityRules(feature.properties?.rules, vehicleTypeIds);
      const zone = classifyMobilityRules(rules, DEFAULT_SLOW_ZONE_KPH);
      if (!zone) continue;

      features.push({
        type: "Feature",
        geometry: clippedGeometry,
        properties: {
          contextKind: "restriction_zone",
          contextId: `entur:${hashParts([
            systemId ?? "unknown",
            feature.properties?.name ?? "unnamed",
            JSON.stringify(clippedGeometry),
          ])}`,
          systemId,
          providerId: null,
          providerName: systemId ?? null,
          providerGroupId: null,
          providerGroupName: null,
          zoneClass: zone.zoneClass,
          zoneName: feature.properties?.name ?? null,
          z: 0,
          formFactors: [],
          vehicleTypeIds: [...new Set(rules.flatMap((rule) => rule.vehicleTypeIds ?? []))].sort(),
          maximumSpeedKph: zone.maximumSpeedKph ?? null,
          rideStartAllowed: rules.every((rule) => rule.rideStartAllowed),
          rideEndAllowed: rules.every((rule) => rule.rideEndAllowed),
          rideThroughAllowed: rules.every((rule) => rule.rideThroughAllowed),
          stationParking: rules.some((rule) => rule.stationParking === true),
        },
      });
    }
  }

  if (features.length === 0) return null;

  return {
    geojson: {
      type: "FeatureCollection",
      features,
    },
  };
}
