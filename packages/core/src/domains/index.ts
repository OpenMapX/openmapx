export type DomainId =
  | "geocoding"
  | "routing"
  | "transit"
  | "data-source"
  | "map-overlay"
  | "poi-search"
  | "photos"
  | "knowledge"
  | "street-view"
  | "weather";

export interface DomainDefinition {
  id: DomainId;
  description: string;
  providerInterface: string;
  supportsMultiple: boolean;
  mergeStrategy?: "first-wins" | "merge-all" | "fallback-chain" | "regional";
}

export const DOMAIN_DEFINITIONS: Record<DomainId, DomainDefinition> = {
  geocoding: {
    id: "geocoding",
    description: "Forward/reverse geocoding and autocomplete",
    providerInterface: "GeocodingProvider",
    supportsMultiple: true,
    mergeStrategy: "fallback-chain",
  },
  routing: {
    id: "routing",
    description: "Point-to-point routing and directions",
    providerInterface: "RoutingProvider",
    supportsMultiple: true,
    mergeStrategy: "first-wins",
  },
  transit: {
    id: "transit",
    description: "Public transit stops, departures, and trip planning",
    providerInterface: "TransitProvider",
    supportsMultiple: true,
    mergeStrategy: "regional",
  },
  "data-source": {
    id: "data-source",
    description: "Searchable data sources with filters (fuel, EV, parking)",
    providerInterface: "DataSourceProvider",
    supportsMultiple: true,
    mergeStrategy: "merge-all",
  },
  "map-overlay": {
    id: "map-overlay",
    description: "Map visualization overlays (traffic, weather, etc.)",
    providerInterface: "MapOverlayProvider",
    supportsMultiple: true,
    mergeStrategy: "merge-all",
  },
  "poi-search": {
    id: "poi-search",
    description: "Point-of-interest category search",
    providerInterface: "PoiSearchProvider",
    supportsMultiple: true,
    mergeStrategy: "merge-all",
  },
  photos: {
    id: "photos",
    description: "Place photo providers",
    providerInterface: "PhotoProvider",
    supportsMultiple: true,
    mergeStrategy: "merge-all",
  },
  knowledge: {
    id: "knowledge",
    description: "Place knowledge (Wikipedia, Wikidata)",
    providerInterface: "KnowledgeProvider",
    supportsMultiple: true,
    mergeStrategy: "merge-all",
  },
  "street-view": {
    id: "street-view",
    description: "Street-level imagery",
    providerInterface: "StreetViewProvider",
    supportsMultiple: false,
  },
  weather: {
    id: "weather",
    description: "Current weather conditions and forecasts",
    providerInterface: "WeatherProvider",
    supportsMultiple: true,
    mergeStrategy: "fallback-chain",
  },
};

export type { DataSourceProvider } from "./data-source";
export type { GeocodingProvider } from "./geocoding";
export type { KnowledgeProvider, KnowledgeResult, KnowledgeSource } from "./knowledge";
export type {
  GeoJsonFeatureCollection,
  MapOverlayData,
  MapOverlayDetail,
  MapOverlayProvider,
} from "./map-overlay";
export type { PhotoProvider } from "./photos";
export type { PoiSearchProvider, PoiSearchResult } from "./poi-search";
export type { RoutingOptions, RoutingProvider } from "./routing";
export type { StreetViewProvider } from "./street-view";
export type { TransitProvider } from "./transit";
export type {
  CurrentWeather,
  DailyForecastPoint,
  HourlyForecastPoint,
  WeatherAttribution,
  WeatherOptions,
  WeatherProvider,
  WeatherResponse,
} from "./weather";
