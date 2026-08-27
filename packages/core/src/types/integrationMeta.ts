/**
 * Minimal shapes for the integration metadata that core utilities and hooks
 * consume. These are structural duplicates of the canonical types defined in
 * `@openmapx/integration-framework` — kept local so that core doesn't depend
 * on integration-framework (which itself depends on core). Consumers that
 * need the full manifest types should import from `@openmapx/integration-framework`
 * directly; structural compatibility lets them interop.
 */

export interface IntegrationDataSource {
  sourceId: string;
  name: string;
  url: string;
  license: string;
  providerCountry: string;
  providerPrivacyUrl: string;
  licenseUrl?: string;
  attribution?: string;
  commercialUse?: "yes" | "no" | "conditional" | "unknown";
  endUserExposure?: "direct" | "mixed" | "proxied" | "server-only" | "build-time";
  personalData?: boolean;
  cookies?: boolean;
  dpaAvailable?: boolean;
  dpaUrl?: string;
}

export interface CacheClient {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Loader signal belongs to the shared cache fill, not any one request. */
  withCache<T>(
    key: string,
    ttlSeconds: number,
    fn: (operationSignal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
    shouldCache?: (value: T) => boolean,
  ): Promise<T>;
}

export type IntegrationStrings = Record<string, Record<string, unknown>>;

export interface IntegrationHealthCheck {
  type: "http" | "ping" | "tcp" | "custom";
  name?: string;
  url?: string;
  urlTemplate?: string;
  headers?: Record<string, string>;
  requiredConfigKeys?: string[];
  category?: string;
}

export interface IntegrationFrontendMeta {
  mapLayer?: boolean;
  legend?: boolean;
  panel?: boolean;
  searchCategory?: {
    id: string;
    label?: string;
    showInChipBar?: boolean;
    iconPath?: string;
  };
  layerSelector?: {
    group: "map-details" | "map-tools" | "map-types";
    labelKey: string;
    icon?: string;
    preview?: string | null;
    quickSelector?: boolean;
  };
  overlay?: {
    excludes?: string[];
    minZoom?: number;
  };
}

export interface LoadedIntegrationMeta {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  domains: string[];
  frontend?: IntegrationFrontendMeta;
  dataSources?: IntegrationDataSource[];
  healthCheck?: IntegrationHealthCheck | IntegrationHealthCheck[];
  strings?: IntegrationStrings;
}
