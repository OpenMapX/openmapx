// packages/core/src/services/types.ts
//
// Public types for the service plugin system. The Zod schemas in
// manifest-schema.ts are the source of truth for runtime validation;
// these types provide the editor-facing shape and are inferred from
// the schemas where possible.

export type ServiceQuality = "built-in" | "community-verified" | "community";

export interface ServiceHealthCheck {
  type: "http" | "tcp" | "exec";
  path?: string;
  port?: number;
  command?: string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
}

export interface ServicePortMapping {
  container: number;
  host: number;
  protocol?: "tcp" | "udp";
  bindAddress?: string;
}

/**
 * A secondary Traefik route attached to the same backend service. Used when
 * one container needs to handle multiple paths under the same host — e.g.
 * `app-api` serves `/api/*` (the primary) AND `/health` (an exact-match
 * secondary for external uptime probes).
 */
export interface ServiceProxyAdditionalRoute {
  /** Path prefix match (`PathPrefix(...)`); pick this OR `path`. */
  pathPrefix?: string;
  /** Exact path match (`Path(...)`); pick this OR `pathPrefix`. */
  path?: string;
  /** Per-route middleware overrides; if omitted, the primary route's middleware applies. */
  middleware?: string[];
}

export interface ServiceProxyExposure {
  enabled: boolean;
  pathPrefix?: string;
  stripPrefix?: boolean;
  middleware?: string[];
  authRequired?: boolean;
  /**
   * Traefik router priority. Higher wins when multiple rules could match the
   * same path. Useful for catch-all routes like `app-web` (priority 1) so that
   * more specific routes take precedence.
   */
  priority?: number;
  /**
   * Additional routes pointing at the same backend service (e.g. an exact
   * `/health` match alongside a `/api` prefix). Each renders as a separate
   * Traefik router with the same `loadbalancer.server.port`.
   */
  additionalRoutes?: ServiceProxyAdditionalRoute[];
}

export interface ServiceExposure {
  hostPorts?: ServicePortMapping[];
  proxy?: ServiceProxyExposure;
}

export interface ServiceVolume {
  name: string;
  mountAt: string;
  readOnly?: boolean;
  backup?: boolean;
}

export interface ServiceConsumes {
  type: string;
  mountAt: string;
  readOnly?: boolean;
  required?: boolean;
}

export interface ServiceProduces {
  type: string;
  sourceDir: string;
}

/**
 * Services may bind-mount files from their own directory (and, for built-in
 * services only, a small whitelist of host-owned special sources) into the
 * container.
 *
 * source:
 *  - Any quality: A relative path under the service's directory (no "..", no
 *    absolute paths). e.g. `config/valhalla.json`, `config/dynamic` — resolved
 *    against the service's install location at render time (`services/<slug>/`
 *    for built-ins; `services/.community/<hash>/<slug>/` for community).
 *  - Built-in only: A `@`-prefixed special source from a known whitelist:
 *    - `@docker-socket` → `/var/run/docker.sock`
 *    - `@service:<other-slug>:<rel-path>` → mounts a file/dir from another
 *      built-in service's directory. Example: pelias-placeholder + pelias-pip
 *      use `@service:pelias:config/pelias.json` to share pelias's config
 *      without duplicating it. The renderer fails fast if the named service
 *      is unknown or the path escapes its directory.
 *
 * Community services CANNOT use `@`-special sources (enforced by post-parse
 * validation) — those grant host-level access and are reserved for first-party
 * services. Community services CAN bind-mount their own config files, since
 * the source is sandboxed to their install directory and the content is
 * auditable in the admin panel's install preview.
 *
 * target: absolute path inside the container.
 * readOnly: defaults to true.
 */
export interface ServiceBindMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface ServiceContainer {
  image: string;
  tag: string;
  expose?: number[];
  command?: string[] | string;
  entrypoint?: string[] | string;
  environment?: Record<string, string>;
  workingDir?: string;
  user?: string;
  shmSize?: string;
  capAdd?: string[];
  capDrop?: string[];
  devices?: string[];
  privileged?: boolean;
  networkMode?: "bridge" | "host";
  memory?: string;
  restart?: "no" | "on-failure" | "always" | "unless-stopped";
  healthcheck?: ServiceHealthCheck;
  dependsOn?: Array<{ service: string; condition?: "service_started" | "service_healthy" }>;
  logging?: { driver: string; options?: Record<string, string> };
}

export interface ServiceUI {
  icon?: string;
  category?: string;
}

export interface ServiceManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  documentation?: string;
  quality: ServiceQuality;
  platform?: string;

  container: ServiceContainer;

  provides?: string[];
  consumes?: ServiceConsumes[];
  produces?: ServiceProduces[];

  configSchema?: Record<string, unknown>;
  envVars?: Array<{ name: string; required?: boolean; description?: string; default?: string }>;

  volumes?: ServiceVolume[];
  bindMounts?: ServiceBindMount[];
  exposure?: ServiceExposure;

  buildCommand?: string;

  ui?: ServiceUI;
}

export interface LoadedService {
  manifest: ServiceManifest;
  directory: string;
  isBuiltIn: boolean;
  enabled: boolean;
}

export interface IntegrationRequirement {
  service?: string;
  capability?: string;
  optional?: boolean;
}

export interface ResolutionMatch {
  serviceId: string;
  source: "exact-service" | "capability" | "git-url";
}

export interface ResolutionResult {
  satisfied: boolean;
  match?: ResolutionMatch;
  candidates?: string[];
  reason?: "ambiguous" | "no-providers" | "service-not-installed" | "service-disabled";
}

/**
 * Supported dataset types that the data-manager can produce / track. Must stay
 * aligned with the data-manager service's `produces:` declarations and with
 * `services/data-manager/src/state.ts` where this is mirrored for the service.
 */
export type DatasetType =
  | "osm-pbf"
  | "osm-pbf-bz2"
  | "gtfs"
  | "tile-fonts"
  | "tile-sprites"
  | "tile-style";

export interface DatasetMetadata {
  type: DatasetType;
  id: string;
  region?: string;
  url?: string;
  sizeBytes: number;
  downloadedAt: string;
  sha256?: string;
  path: string;
}

export interface HardlinkEntry {
  source: string;
  target: string;
  consumerService: string;
  dataType: string;
}

export interface RenderResult {
  composeYaml: string;
  envFile: string;
  hardlinkPlan: HardlinkEntry[];
}
