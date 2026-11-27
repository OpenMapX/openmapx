import type { IntegrationContext } from "../context";

/** The provider domains an integration registers into, by the key the host stores them under. */
export type ProviderDomain =
  | "transit"
  | "live-transit"
  | "data-source"
  | "weather"
  | "air-quality"
  | "geocoding"
  | "routing"
  | "ride-hailing"
  | "road-conditions"
  | "fuel-stations"
  | "parking-sites"
  | "charging-sites"
  | "cameras"
  | "message-signs"
  | "landmark-models"
  | "road-weather"
  | "service-vehicles"
  | "border-crossings"
  | "hazards"
  | "photos"
  | "street-level-imagery"
  | "reviews"
  | "poi-search"
  | "search-suggestions"
  | "knowledge"
  | "gtfs-catalog";

/**
 * The members a provider of one domain cannot do without: the non-optional
 * members of its contract. `key` names the member that identifies the provider
 * inside its integration, and is always required.
 */
export interface ProviderShape {
  registrar: keyof IntegrationContext;
  key: "id" | "name" | null;
  props: readonly string[];
  methods: readonly string[];
}

/**
 * Installed code is not type-checked against the contracts, so the host checks
 * at registration what the compiler checks for built-ins; a provider missing a
 * member would otherwise fail on the first request that reaches it.
 */
export const PROVIDER_SHAPES = {
  transit: {
    registrar: "registerTransitProvider",
    key: "id",
    props: ["prefix", "coverage", "priority", "role", "capabilities", "attribution"],
    methods: [],
  },
  "live-transit": {
    registrar: "registerRealtimeProvider",
    key: "id",
    props: ["coverage", "priority", "capabilities", "attribution"],
    methods: [],
  },
  "data-source": {
    registrar: "registerMobilityDataSource",
    key: "id",
    props: ["meta", "attribution"],
    methods: ["getFilters", "search", "getDetail"],
  },
  weather: {
    registrar: "registerWeatherProvider",
    key: "id",
    props: ["priority"],
    methods: ["getCurrentWeather"],
  },
  "air-quality": {
    registrar: "registerAirQualityProvider",
    key: "id",
    props: ["sourceIds", "priority", "capabilities", "coverage"],
    methods: [],
  },
  geocoding: {
    registrar: "registerGeocodingProvider",
    key: null,
    props: [],
    methods: ["geocode", "autocomplete", "reverseGeocode"],
  },
  routing: {
    registrar: "registerRoutingProvider",
    key: "id",
    props: ["supportedModes"],
    methods: ["getRoute"],
  },
  "ride-hailing": {
    registrar: "registerRideProvider",
    key: "id",
    props: ["meta", "capabilities", "permitsComparison", "attribution"],
    methods: ["getAvailability", "createHandoff"],
  },
  "road-conditions": {
    registrar: "registerRoadConditionsProvider",
    key: "id",
    props: [],
    methods: ["getEvents"],
  },
  "fuel-stations": {
    registrar: "registerFuelStationProvider",
    key: "id",
    props: [],
    methods: ["searchStations", "getStation"],
  },
  "parking-sites": {
    registrar: "registerParkingSiteProvider",
    key: "id",
    props: [],
    methods: ["searchSites", "getSite"],
  },
  "charging-sites": {
    registrar: "registerChargingSiteProvider",
    key: "id",
    props: [],
    methods: ["searchSites", "getSite"],
  },
  cameras: {
    registrar: "registerCameraProvider",
    key: "id",
    props: [],
    methods: ["searchCameras", "getCamera"],
  },
  "message-signs": {
    registrar: "registerMessageSignProvider",
    key: "id",
    props: [],
    methods: ["searchSigns", "getSign"],
  },
  "landmark-models": {
    registrar: "registerLandmarkModelProvider",
    key: "id",
    props: ["sourceIds"],
    methods: ["snapshot", "fetchModelGzip"],
  },
  "road-weather": {
    registrar: "registerRoadWeatherProvider",
    key: "id",
    props: [],
    methods: ["searchStations", "getStation"],
  },
  "service-vehicles": {
    registrar: "registerServiceVehicleProvider",
    key: "id",
    props: [],
    methods: ["searchVehicles", "getVehicle"],
  },
  "border-crossings": {
    registrar: "registerBorderCrossingProvider",
    key: "id",
    props: [],
    methods: ["searchCrossings", "getCrossing"],
  },
  hazards: {
    registrar: "registerHazardsProvider",
    key: "id",
    props: [],
    methods: ["getAlerts", "getNaturalHazards", "getFirePixels", "getFireDensity"],
  },
  photos: {
    registrar: "registerPhotoProvider",
    key: "id",
    props: ["name"],
    methods: ["search"],
  },
  "street-level-imagery": {
    registrar: "registerStreetLevelProvider",
    key: "id",
    props: ["name"],
    methods: ["capabilities", "findNearest", "getImage", "getLinks", "searchImages"],
  },
  reviews: {
    registrar: "registerReviewProvider",
    key: "id",
    props: ["name"],
    methods: ["getReviews", "getAggregate"],
  },
  "poi-search": {
    registrar: "registerPoiSearchProvider",
    key: "id",
    props: ["categories"],
    methods: ["search"],
  },
  "search-suggestions": {
    registrar: "registerSearchSuggestionProvider",
    key: "id",
    props: [],
    methods: ["searchSuggestions"],
  },
  knowledge: {
    registrar: "registerKnowledgeProvider",
    key: "name",
    props: [],
    methods: ["lookup"],
  },
  "gtfs-catalog": {
    registrar: "registerGtfsCatalogProvider",
    key: "id",
    props: [],
    methods: ["listFeeds"],
  },
} as const satisfies Record<ProviderDomain, ProviderShape>;

/** The `IntegrationContext` methods that register a provider. */
export type ProviderRegistrar = (typeof PROVIDER_SHAPES)[ProviderDomain]["registrar"];

const MAX_PROVIDER_KEY_LENGTH = 128;

/**
 * Throws for the first required member `provider` lacks: an invalid key, then a
 * prop that is `undefined`, then a method that is not a function.
 */
export function assertProviderShape(
  domain: ProviderDomain,
  provider: unknown,
  integrationId: string,
): void {
  const shape: ProviderShape = PROVIDER_SHAPES[domain];
  const target =
    (typeof provider === "object" && provider !== null) || typeof provider === "function"
      ? provider
      : {};
  const member = (name: string): unknown => Reflect.get(target, name);
  if (shape.key) {
    const key = member(shape.key);
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_PROVIDER_KEY_LENGTH) {
      throw new Error(
        `Integration ${integrationId}: ${domain} provider has an invalid ${shape.key}`,
      );
    }
  }
  for (const prop of shape.props) {
    if (member(prop) === undefined) {
      throw new Error(`Integration ${integrationId}: ${domain} provider is missing ${prop}`);
    }
  }
  for (const method of shape.methods) {
    if (typeof member(method) !== "function") {
      throw new Error(`Integration ${integrationId}: ${domain} provider is missing ${method}`);
    }
  }
}
