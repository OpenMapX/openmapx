/**
 * The IDs of the services the platform itself is built from. Code that names a
 * core service, or decides something because of which core service it is,
 * refers to it through these instead of a string literal, so the compiler
 * finds every such place and no deny-list can silently miss a core service.
 *
 * This module imports nothing, so browser and server bundles can both use it.
 */
export const CORE_SERVICE_ID = {
  api: "api",
  web: "web",
  dataManager: "data-manager",
  opsAgent: "ops-agent",
  transitousRunner: "transitous-runner",
  traefik: "traefik",
  postgis: "postgis",
  redis: "redis",
  wellKnown: "well-known",
} as const;

export type CoreServiceId = (typeof CORE_SERVICE_ID)[keyof typeof CORE_SERVICE_ID];

/** Prefix of every service's project-unique DNS name; no service ID or declared alias may use it. */
export const SERVICE_NETWORK_ALIAS_PREFIX = "openmapx-";

/**
 * The DNS name a service answers to on the stack's own networks, such as
 * `openmapx-postgis`. Internal URLs use it, never the bare service ID: a
 * service routed by an operator's proxy also joins that proxy's shared
 * network, where a bare ID such as `redis` can resolve to another project's
 * container.
 */
export function serviceNetworkAlias(serviceId: string): string {
  return `${SERVICE_NETWORK_ALIAS_PREFIX}${serviceId}`;
}

const { api, web, dataManager, opsAgent, transitousRunner, traefik, postgis, redis, wellKnown } =
  CORE_SERVICE_ID;

/** Runtime services whose images a generation pins as one release. */
export const RELEASE_PINNED_SERVICE_IDS = [
  api,
  web,
  dataManager,
  opsAgent,
  transitousRunner,
] as const;
export type ReleasePinnedServiceId = (typeof RELEASE_PINNED_SERVICE_IDS)[number];

/**
 * The services a configuration change replaces through the self-update
 * handoff rather than an ordinary recreate, in the order a self-update
 * replaces them: the database before its clients, the operations agent last.
 */
export const PROTECTED_CONFIGURATION_SERVICE_IDS = [
  postgis,
  redis,
  web,
  api,
  traefik,
  opsAgent,
] as const;

/**
 * The control plane: services ordinary service actions and runtime recovery
 * never manage, because they run the management itself.
 */
export const CONTROL_PLANE_SERVICE_IDS = [opsAgent, api, traefik] as const;

/** Control-plane services an administrator may restart through the core-restart workflow. */
export const CORE_RESTART_SERVICE_IDS = [api, traefik] as const;
export type CoreRestartServiceId = (typeof CORE_RESTART_SERVICE_IDS)[number];

/** The root services of a default installation. */
export const DEFAULT_SELECTED_SERVICE_IDS = [
  traefik,
  wellKnown,
  api,
  web,
  postgis,
  redis,
  dataManager,
] as const;
