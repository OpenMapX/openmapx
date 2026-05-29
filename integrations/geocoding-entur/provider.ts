import {
  type AutocompleteResult,
  createPlace,
  fetchJson,
  type Place,
  type ReverseGeocodingResult,
  resolvePoiIconPath,
  type SearchResult,
} from "@openmapx/core";
import type { GeocodingProvider as GeocodingProviderImpl } from "@openmapx/integration-geocoding/types";
import type { TransitStop, TransportMode } from "@openmapx/mobility-core/transit";

type EnturMultiModal = "parent" | "child" | "all";

interface EnturFeatureCollection {
  features?: EnturFeature[];
}

interface EnturFeature {
  geometry?: {
    coordinates?: [number, number];
  };
  properties?: EnturFeatureProperties;
}

interface EnturFeatureProperties {
  id?: string;
  source_id?: string;
  name?: string;
  label?: string;
  layer?: string;
  locality?: string;
  county?: string;
  country_a?: string;
  category?: string[];
  mode?: Array<Record<string, string | null>>;
  description?: EnturLocalizedText | EnturLocalizedText[];
}

type EnturLocalizedText = Record<string, string>;

interface EnturIdBundle {
  canonicalId: string;
  ids: Record<string, string>;
  primaryScheme: string;
}

const DEFAULT_BASE_URL = "https://api.entur.io/geocoder/v1";
const DEFAULT_CLIENT_NAME = "openmapx-server";
const DEFAULT_BOUNDARY_COUNTRY = "NOR";
const DEFAULT_MULTI_MODAL: EnturMultiModal = "parent";
const REQUEST_TIMEOUT_MS = 4_000;

const CATEGORY_PRIORITY = [
  "railStation",
  "metroStation",
  "tramStation",
  "onstreetTram",
  "busStation",
  "coachStation",
  "onstreetBus",
  "ferryPort",
  "ferryStop",
  "harbourPort",
  "airport",
  "liftStation",
  "vehicleRailInterchange",
  "GroupOfStopPlaces",
  "Places",
  "Street address",
  "Street",
] as const;

const CATEGORY_MODE_MAP: Record<string, TransportMode> = {
  railStation: "rail",
  vehicleRailInterchange: "rail",
  metroStation: "subway",
  tramStation: "tram",
  onstreetTram: "tram",
  busStation: "bus",
  coachStation: "bus",
  onstreetBus: "bus",
  ferryPort: "ferry",
  ferryStop: "ferry",
  harbourPort: "ferry",
  liftStation: "gondola",
};

const MODE_KEY_MAP: Record<string, TransportMode> = {
  bus: "bus",
  rail: "rail",
  metro: "subway",
  subway: "subway",
  tram: "tram",
  ferry: "ferry",
  water: "ferry",
  gondola: "gondola",
  cablecar: "cable_car",
  cable_car: "cable_car",
  cableway: "cable_car",
  funicular: "funicular",
  monorail: "monorail",
};

let baseUrl = DEFAULT_BASE_URL;
let clientName = DEFAULT_CLIENT_NAME;
let boundaryCountry = DEFAULT_BOUNDARY_COUNTRY;
let multiModal: EnturMultiModal = DEFAULT_MULTI_MODAL;

export function setEnturGeocodingConfig(config: {
  endpoint?: string;
  clientName?: string;
  boundaryCountry?: string;
  multiModal?: EnturMultiModal;
}): void {
  baseUrl =
    config.endpoint && config.endpoint.trim().length > 0
      ? config.endpoint.replace(/\/+$/, "")
      : DEFAULT_BASE_URL;
  clientName =
    config.clientName && config.clientName.trim().length > 0
      ? config.clientName.trim()
      : DEFAULT_CLIENT_NAME;
  boundaryCountry =
    config.boundaryCountry && config.boundaryCountry.trim().length > 0
      ? config.boundaryCountry.trim().toUpperCase()
      : "";
  multiModal = config.multiModal ?? DEFAULT_MULTI_MODAL;
}

function getNativeId(properties: EnturFeatureProperties | undefined): string | undefined {
  return properties?.id ?? properties?.source_id;
}

function buildIdBundle(nativeId: string): EnturIdBundle {
  const ids: Record<string, string> = { entur: nativeId };
  let primaryScheme = "entur";

  if (nativeId.startsWith("NSR:")) {
    ids.nsr = nativeId.slice("NSR:".length);
    primaryScheme = "nsr";
  }

  return {
    canonicalId: `${primaryScheme}:${ids[primaryScheme]}`,
    ids,
    primaryScheme,
  };
}

function preferredCategory(categories: string[] | undefined): string | undefined {
  if (!categories?.length) return undefined;

  for (const candidate of CATEGORY_PRIORITY) {
    const match = categories.find((category) => category === candidate);
    if (match) return match;
  }

  return categories.find((category) => category.toLowerCase() !== "poi") ?? categories[0];
}

function isTransitFeature(feature: EnturFeature): boolean {
  return feature.properties?.layer === "venue";
}

function mapFeatureType(feature: EnturFeature): SearchResult["type"] {
  if (feature.properties?.layer === "venue") return "poi";

  const category = preferredCategory(feature.properties?.category);
  if (category === "Street address") return "address";
  if (category === "Street") return "street";
  if (category === "Places") return "region";
  if (category === "GroupOfStopPlaces") return "poi";

  if (feature.properties?.layer === "address") return "poi";
  return "region";
}

function normalizeIconCategory(rawCategory: string | undefined): string | undefined {
  if (!rawCategory) return undefined;
  if (rawCategory === "railStation" || rawCategory === "vehicleRailInterchange") {
    return "railway_station";
  }
  if (rawCategory === "airport") return "airport";
  return rawCategory;
}

function countryCodeAlpha2(alpha3: string | undefined): string | undefined {
  if (alpha3 === "NOR") return "no";
  if (alpha3 === "SWE") return "se";
  return undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
}

function pickLocalizedValue(
  value: EnturLocalizedText | EnturLocalizedText[] | undefined,
  lang?: string,
): string | undefined {
  if (!value) return undefined;

  const entries = Array.isArray(value) ? value : [value];
  const requested = (lang ?? "").toLowerCase();
  const preferredKeys =
    requested === "en"
      ? ["eng", "en"]
      : requested === "no" || requested === "nb" || requested === "nn"
        ? ["nor", "nob", "nno", "no"]
        : requested
          ? [requested]
          : [];

  for (const key of preferredKeys) {
    const match = entries.find((entry) => typeof entry[key] === "string");
    if (match?.[key]) return match[key];
  }

  for (const entry of entries) {
    const first = Object.values(entry).find((candidate) => candidate.trim().length > 0);
    if (first) return first;
  }

  return undefined;
}

function buildSublabel(feature: EnturFeature, lang?: string): string | undefined {
  const properties = feature.properties;
  const description = pickLocalizedValue(properties?.description, lang);
  const locality = properties?.locality;
  const county = properties?.county;
  const parts = uniqueStrings([description, locality, county !== locality ? county : undefined]);
  if (parts.length > 0) return parts.join(", ");

  const name = properties?.name;
  const label = properties?.label;
  if (name && label && label !== name) {
    return label.startsWith(`${name}, `) ? label.slice(name.length + 2) : label;
  }

  return undefined;
}

function inferTransitModes(feature: EnturFeature): TransportMode[] {
  const modes = new Set<TransportMode>();

  for (const entry of feature.properties?.mode ?? []) {
    for (const [key] of Object.entries(entry)) {
      const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
      const mapped = MODE_KEY_MAP[normalized];
      if (mapped) modes.add(mapped);
    }
  }

  for (const category of feature.properties?.category ?? []) {
    const mapped = CATEGORY_MODE_MAP[category];
    if (mapped) modes.add(mapped);
  }

  return modes.size > 0 ? [...modes] : ["bus"];
}

function featureCoordinates(feature: EnturFeature): [number, number] | undefined {
  const coordinates = feature.geometry?.coordinates;
  if (!coordinates || coordinates.length < 2) return undefined;
  const [lng, lat] = coordinates;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined;
  return [lng, lat];
}

function featureLabel(feature: EnturFeature): string {
  return (
    feature.properties?.label ??
    feature.properties?.name ??
    getNativeId(feature.properties) ??
    "Unknown place"
  );
}

function featureName(feature: EnturFeature): string {
  return feature.properties?.name ?? featureLabel(feature);
}

function featureCity(feature: EnturFeature): string | undefined {
  const locality = feature.properties?.locality;
  const county = feature.properties?.county;
  const parts = uniqueStrings([locality, county !== locality ? county : undefined]);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function featureRawCategory(feature: EnturFeature): string | undefined {
  return preferredCategory(feature.properties?.category);
}

function featureToTransitStop(feature: EnturFeature): TransitStop | undefined {
  if (!isTransitFeature(feature)) return undefined;

  const nativeId = getNativeId(feature.properties);
  const coordinates = featureCoordinates(feature);
  if (!nativeId || !coordinates) return undefined;

  const [lng, lat] = coordinates;
  const idBundle = buildIdBundle(nativeId);

  return {
    id: idBundle.canonicalId,
    primaryScheme: idBundle.primaryScheme,
    ids: idBundle.ids,
    name: featureName(feature),
    lat,
    lng,
    modes: inferTransitModes(feature),
    provider: "entur",
  };
}

function featureToAutocompleteResult(
  feature: EnturFeature,
  lang?: string,
): AutocompleteResult | null {
  const nativeId = getNativeId(feature.properties);
  if (!nativeId) return null;

  const coordinates = featureCoordinates(feature);
  const rawCategory = featureRawCategory(feature);
  const idBundle = buildIdBundle(nativeId);
  const transitStop = featureToTransitStop(feature);

  if (transitStop) {
    return {
      id: idBundle.canonicalId,
      label: transitStop.name,
      sublabel: buildSublabel(feature, lang),
      coordinates,
      type: "transit_stop",
      transitStop,
      rawCategory,
    };
  }

  const type: AutocompleteResult["type"] = mapFeatureType(feature);
  return {
    id: idBundle.canonicalId,
    label: featureName(feature),
    sublabel: buildSublabel(feature, lang),
    coordinates,
    type,
    iconPath: rawCategory
      ? resolvePoiIconPath(normalizeIconCategory(rawCategory) ?? rawCategory)
      : undefined,
    rawCategory,
  };
}

function featureToSearchResult(feature: EnturFeature): SearchResult | null {
  const nativeId = getNativeId(feature.properties);
  const coordinates = featureCoordinates(feature);
  if (!nativeId || !coordinates) return null;

  const idBundle = buildIdBundle(nativeId);
  return {
    id: idBundle.canonicalId,
    label: featureLabel(feature),
    coordinates,
    type: mapFeatureType(feature),
    confidence: 1,
    rawCategory: featureRawCategory(feature),
  };
}

export function enturFeatureToPlace(feature: EnturFeature, lang?: string): Place | null {
  const nativeId = getNativeId(feature.properties);
  const coordinates = featureCoordinates(feature);
  if (!nativeId || !coordinates) return null;

  const idBundle = buildIdBundle(nativeId);
  return createPlace({
    primaryScheme: idBundle.primaryScheme,
    ids: idBundle.ids,
    name: featureName(feature),
    address: featureLabel(feature),
    city: featureCity(feature),
    countryCode: countryCodeAlpha2(feature.properties?.country_a),
    coordinates,
    category: isTransitFeature(feature) ? "station" : mapFeatureType(feature),
    rawCategory: featureRawCategory(feature),
    description: pickLocalizedValue(feature.properties?.description, lang),
  });
}

async function fetchEntur(
  path: "/autocomplete" | "/reverse",
  params: Record<string, string | undefined>,
): Promise<EnturFeatureCollection> {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value && value.length > 0) {
      url.searchParams.set(key, value);
    }
  }

  return fetchJson<EnturFeatureCollection>(url.toString(), {
    timeoutMs: REQUEST_TIMEOUT_MS,
    userAgent: null,
    headers: { "ET-Client-Name": clientName },
    errorMessage: ({ status }) => `Entur geocoding error ${status}`,
  });
}

async function fetchEnturAutocomplete(
  text: string,
  size: number,
  lang?: string,
  options?: {
    boundaryCountry?: string;
    multiModal?: EnturMultiModal;
  },
): Promise<EnturFeature[]> {
  const data = await fetchEntur("/autocomplete", {
    text,
    lang,
    size: String(size),
    "boundary.country": options?.boundaryCountry,
    multiModal: options?.multiModal,
  });
  return data.features ?? [];
}

export async function lookupEnturPlaceById(rawId: string, lang?: string): Promise<Place | null> {
  const features = await fetchEnturAutocomplete(rawId, 10, lang, { multiModal: "all" });
  const match = features.find((feature) => getNativeId(feature.properties) === rawId);
  return match ? enturFeatureToPlace(match, lang) : null;
}

export const enturGeocodingService: GeocodingProviderImpl = {
  async geocode(query: string, lang?: string): Promise<SearchResult[]> {
    const features = await fetchEnturAutocomplete(query, 10, lang, {
      boundaryCountry: boundaryCountry || undefined,
      multiModal,
    });
    return features
      .map((feature) => featureToSearchResult(feature))
      .filter((result): result is SearchResult => result != null);
  },

  async autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]> {
    const features = await fetchEnturAutocomplete(query, 6, lang, {
      boundaryCountry: boundaryCountry || undefined,
      multiModal,
    });
    return features
      .map((feature) => featureToAutocompleteResult(feature, lang))
      .filter((result): result is AutocompleteResult => result != null);
  },

  async reverseGeocode(
    lat: number,
    lng: number,
    lang?: string,
  ): Promise<ReverseGeocodingResult | null> {
    const data = await fetchEntur("/reverse", {
      "point.lat": String(lat),
      "point.lon": String(lng),
      lang,
      size: "1",
    });
    const feature = data.features?.[0];
    if (!feature) return null;

    return {
      address: featureLabel(feature),
      city: featureCity(feature) ?? "",
    };
  },
};
