/**
 * Every name OpenMapX gives to state it keeps in a browser: Web Storage keys,
 * records in the key-value IndexedDB database, the history-state member, the
 * IndexedDB database names and the runtime Cache Storage names.
 *
 * Keys follow `openmapx:<area>:<name>` with kebab-case segments; database and
 * cache names follow `openmapx:<name>`. These names are a stored format: the
 * privacy device export writes preference keys verbatim and the privacy page
 * names some of them, so a rename resets that state on every device.
 *
 * Code outside this module refers to these constants and never spells a key as
 * a string literal (enforced by `storageKeys.test.ts`).
 */

export type BrowserStorageKind = "localStorage" | "sessionStorage" | "indexedDb";

export interface BrowserStorageKey {
  readonly key: string;
  readonly storage: BrowserStorageKind;
  /** For `indexedDb`: the database (see {@link INDEXED_DB_DATABASES}) holding the record. */
  readonly database?: IndexedDbDatabaseName;
  /** Copied verbatim into the `preferences` of the privacy device export. */
  readonly deviceExport: boolean;
  /** Kept when the account signs out in this browser. */
  readonly survivesSignOut: boolean;
}

function preference(key: string): BrowserStorageKey {
  return { key, storage: "localStorage", deviceExport: true, survivesSignOut: true };
}

function local(key: string): BrowserStorageKey {
  return { key, storage: "localStorage", deviceExport: false, survivesSignOut: true };
}

function session(key: string, survivesSignOut: boolean): BrowserStorageKey {
  return { key, storage: "sessionStorage", deviceExport: false, survivesSignOut };
}

function record(
  key: string,
  database: IndexedDbDatabaseName,
  survivesSignOut: boolean,
): BrowserStorageKey {
  return { key, storage: "indexedDb", database, deviceExport: false, survivesSignOut };
}

export const STORAGE_KEYS = {
  unitSystem: preference("openmapx:settings:unit-system"),
  timeFormat: preference("openmapx:settings:time-format"),
  dateFormat: preference("openmapx:settings:date-format"),
  hapticsEnabled: preference("openmapx:settings:haptics-enabled"),

  aiSearch: preference("openmapx:search:ai-search"),
  nlpCloudConsent: preference("openmapx:search:nlp-cloud-consent"),
  searchHistoryEnabled: preference("openmapx:search:history-enabled"),
  recentSearches: local("openmapx:search:recent-searches"),
  recentDestinations: local("openmapx:search:recent-destinations"),
  recentDestinationsAccount: local("openmapx:search:recent-destinations-account"),

  voiceEnabled: preference("openmapx:navigation:voice-enabled"),
  voiceName: preference("openmapx:navigation:voice-name"),
  voiceGuidanceTiming: preference("openmapx:navigation:voice-guidance-timing"),
  keepScreenOn: preference("openmapx:navigation:keep-screen-on"),
  speedCameraAlerts: preference("openmapx:navigation:speed-camera-alerts"),
  incidentAlerts: preference("openmapx:navigation:incident-alerts"),
  fasterRoutes: preference("openmapx:navigation:faster-routes"),
  autoSwitchFasterRoutes: preference("openmapx:navigation:auto-switch-faster-routes"),
  navigation3d: preference("openmapx:navigation:3d"),
  navigationSession: record("openmapx:navigation:session", "keyValue", true),

  avoidHighways: preference("openmapx:routing:avoid-highways"),
  avoidTolls: preference("openmapx:routing:avoid-tolls"),
  avoidFerries: preference("openmapx:routing:avoid-ferries"),
  avoidIncidents: preference("openmapx:routing:avoid-incidents"),
  bikeProfile: preference("openmapx:routing:bike-profile"),
  bikeHillPreference: preference("openmapx:routing:bike-hill-preference"),
  bikePreferQuietRoads: preference("openmapx:routing:bike-prefer-quiet-roads"),
  bikePreferSmoothSurfaces: preference("openmapx:routing:bike-prefer-smooth-surfaces"),
  bikeSpeedKmh: preference("openmapx:routing:bike-speed-kmh"),

  mapNorthUp: preference("openmapx:map:north-up"),
  touchZoomButtons: preference("openmapx:map:touch-zoom-buttons"),
  rememberMapView: preference("openmapx:map:remember-view"),
  lastMapView: local("openmapx:map:last-view"),
  mapLocalScript: preference("openmapx:map:local-script"),
  globeView: preference("openmapx:map:globe-view"),
  globeLighting: preference("openmapx:map:globe-lighting"),

  evVehicleId: preference("openmapx:ev:vehicle-id"),
  evSocTargetPercent: preference("openmapx:ev:soc-target-percent"),
  evPreferredNetworks: preference("openmapx:ev:preferred-networks"),
  evAvoidedNetworks: preference("openmapx:ev:avoided-networks"),
  evExclusiveNetworks: preference("openmapx:ev:exclusive-networks"),
  evPreferCheaper: preference("openmapx:ev:prefer-cheaper"),
  evHomePricePerKwh: preference("openmapx:ev:home-price-per-kwh"),
  evHomeCurrency: preference("openmapx:ev:home-currency"),

  garageVehicles: local("openmapx:garage:vehicles"),
  garageParked: local("openmapx:garage:parked"),
  garageImportedFor: local("openmapx:garage:imported-for"),

  roadConditions: preference("openmapx:road-conditions:choices"),

  recentMapDataCacheEnabled: preference("openmapx:cache:recent-map-data-enabled"),
  queryCache: record("openmapx:cache:queries", "keyValue", true),

  savedPlacesMirror: record("openmapx:saved:places-mirror", "keyValue", false),

  installPromptDismissedAt: local("openmapx:pwa:install-dismissed-at"),
  serviceWorkerLastAutoReload: session("openmapx:service-worker:last-auto-reload", true),

  privacyPendingExport: session("openmapx:privacy:pending-export", true),

  reviewDraft: session("openmapx:reviews:draft", false),
  mangroveSignerSession: session("openmapx:mangrove:signer-session", false),
  mangrovePendingLogin: session("openmapx:mangrove:pending-login", false),
  mangroveMode: session("openmapx:mangrove:mode", false),

  crowdGrant: local("openmapx:crowd:grant"),
  crowdDeviceKey: record("openmapx:crowd:device-key", "crowd", true),
} as const satisfies Record<string, BrowserStorageKey>;

/**
 * Keys whose last segment is chosen at run time (an API base, an actor id, a
 * scope). The declared prefix ends with `:`.
 */
export const STORAGE_KEY_PREFIXES = {
  adminReauthentication: session("openmapx:admin:reauthentication:", true),
  adminPlatformPreview: session("openmapx:admin:platform-preview:", true),
  adminConfigurationMigrationPreview: session(
    "openmapx:admin:configuration-migration-preview:",
    true,
  ),
  adminCredentialPreview: session("openmapx:admin:credential-preview:", true),
  adminTransitCredentialPreview: session("openmapx:admin:transit-credential-preview:", true),
} as const satisfies Record<string, BrowserStorageKey>;

export type StorageKeyPrefixName = keyof typeof STORAGE_KEY_PREFIXES;

/** The full key for one run-time suffix of a declared prefix. */
export function prefixedStorageKey(name: StorageKeyPrefixName, suffix: string): string {
  return `${STORAGE_KEY_PREFIXES[name].key}${suffix}`;
}

/** Every declared key and prefix, for checks that walk the whole set. */
export const ALL_BROWSER_STORAGE_KEYS: readonly BrowserStorageKey[] = [
  ...Object.values(STORAGE_KEYS),
  ...Object.values(STORAGE_KEY_PREFIXES),
];

/** The localStorage keys the privacy device export copies verbatim. */
export const PREFERENCE_KEYS: readonly string[] = Object.values(STORAGE_KEYS)
  .filter((entry: BrowserStorageKey) => entry.deviceExport)
  .map((entry) => entry.key);

/** The member of `history.state` that holds OpenMapX's back-navigation entry. */
export const HISTORY_STATE_KEY = "openmapx:history:entry";

/** IndexedDB database names. */
export const INDEXED_DB_DATABASES = {
  /** The host's key-value store. */
  keyValue: "openmapx:key-value",
  offlinePackages: "openmapx:offline-packages",
  /** The crowd-report signing identity, a non-extractable key pair. */
  crowd: "openmapx:crowd",
} as const;

export type IndexedDbDatabaseName = keyof typeof INDEXED_DB_DATABASES;

/** Runtime Cache Storage names. Build- or version-scoped names end with `-`. */
export const CACHE_STORAGE_NAMES = {
  appShellPrefix: "openmapx:app-shell-",
  styleAssetsPrefix: "openmapx:style-assets-",
  offlinePackageGlyphsPrefix: "openmapx:offline-package-glyphs-",
  staticAssets: "openmapx:static-assets",
  maplibreRuntimes: "openmapx:maplibre-runtimes",
  scriptFonts: "openmapx:script-fonts",
  mapTiles: "openmapx:map-tiles",
  streetLevelImageryTiles: "openmapx:street-level-imagery-tiles",
  vectorTiles: "openmapx:vector-tiles",
  apiGeodata: "openmapx:api-geodata",
  apiCategorySearch: "openmapx:api-category-search",
  apiAutocomplete: "openmapx:api-autocomplete",
  apiWeather: "openmapx:api-weather",
  apiPhotos: "openmapx:api-photos",
  apiLandmarkCoverage: "openmapx:api-landmark-coverage",
  apiLandmarkCells: "openmapx:api-landmark-cells",
  apiLandmarkModels: "openmapx:api-landmark-models",
  preferences: "openmapx:preferences",
} as const;
