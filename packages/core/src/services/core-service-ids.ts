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
