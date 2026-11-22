import { assertTrustedConfigurationSchema } from "./configuration-schema";
import { serviceNetworkAlias } from "./core-service-ids";
import { validateServiceManifest } from "./manifest-schema";
import { RELEASE_BUILT_IN_SERVICE_IDS } from "./release-authority-inventory";
import type { ServiceManifest } from "./types";

const COMMUNITY_SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The host of a URL, after its scheme and any `user:password@`. */
const URL_HOST =
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/\s?#]*@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?=[:/?#\s"'`,;)]|$)/g;
/** A value that is only a host, optionally with a port: `postgis`, `redis:6379`. */
const HOST_ONLY = /^([A-Za-z0-9][A-Za-z0-9.-]*)(?::\d{1,5})?$/;
/** A name that holds a host: `DB_HOST`, `REDIS_HOSTNAME`, `--db-host`. */
const HOST_NAME = /(?:^|[_-])(?:host|hostname|server|addr|address)$/i;
/** A `NAME=value` word in a command, such as `DB_HOST=postgis` or `--db-host=postgis`. */
const ASSIGNMENT = /^-{0,2}([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/;

/** Every `[name, value]` a manifest passes to its container or offers as a default. */
function addressedValues(manifest: ServiceManifest): [string | null, string][] {
  const { container } = manifest;
  const listed = (value: string[] | string | undefined): [null, string][] =>
    (value === undefined ? [] : Array.isArray(value) ? value : [value]).map((v) => [null, v]);
  const defaults: [string, string][] = [];
  const walk = (schema: unknown) => {
    if (!schema || typeof schema !== "object") return;
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    for (const [key, property] of Object.entries(properties)) {
      const value = (property as { default?: unknown } | null)?.default;
      if (typeof value === "string") defaults.push([key, value]);
      walk(property);
    }
  };
  walk(manifest.configSchema);
  return [
    ...Object.entries(container.environment ?? {}),
    ...listed(container.command),
    ...listed(container.entrypoint),
    ...listed(container.healthcheck?.command),
    ...defaults,
  ];
}

/** The hosts a value names: URL hosts, and the whole value or word under a host-holding name. */
function namedHosts(name: string | null, value: string): string[] {
  const hosts = [...value.matchAll(URL_HOST)].map((match) => match[1] ?? "");
  if (name && HOST_NAME.test(name)) hosts.push(HOST_ONLY.exec(value.trim())?.[1] ?? "");
  for (const word of value.split(/[\s"'`;]+/)) {
    const assignment = ASSIGNMENT.exec(word);
    if (assignment && HOST_NAME.test(assignment[1] ?? ""))
      hosts.push(HOST_ONLY.exec(assignment[2] ?? "")?.[1] ?? "");
    // `postgis:5432` on its own is an address whatever it is called.
    else if (/:\d{1,5}$/.test(word)) hosts.push(HOST_ONLY.exec(word)?.[1] ?? "");
  }
  return hosts.map((host) => host.toLowerCase().replace(/\.$/, ""));
}

/**
 * The built-in services a community manifest addresses by bare ID in its
 * environment, command, healthcheck or configuration defaults. A bridge
 * network carries the bare ID too, but platform traffic uses only
 * `openmapx-<service-id>`.
 */
function bareBuiltInHosts(manifest: ServiceManifest): string[] {
  const builtIn = new Set<string>(RELEASE_BUILT_IN_SERVICE_IDS);
  const hosts = new Set<string>();
  for (const [name, value] of addressedValues(manifest))
    for (const host of namedHosts(name, value)) if (builtIn.has(host)) hosts.add(host);
  return [...hosts].sort();
}

/**
 * Why a community service manifest would be rejected, beyond the third-party
 * manifest schema: a plain service id that no built-in service uses, no
 * built-in service reached by its bare ID, a community quality label, an image
 * pinned by digest, and a configuration schema the trusted renderer accepts.
 * The operations agent applies these rules before it installs a repository and
 * whenever it reads its community store; the API applies them again to the
 * manifests the agent reports.
 */
export function communityServiceManifestProblems(raw: unknown): string[] {
  const validation = validateServiceManifest(raw, { firstParty: false });
  if (!validation.valid) return validation.errors;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["Manifest is not an object"];
  const manifest = raw as ServiceManifest;
  const problems: string[] = [];
  if (!COMMUNITY_SERVICE_ID.test(manifest.id)) {
    problems.push(`Service id "${manifest.id}" may only use lowercase letters, digits and hyphens`);
  }
  // The registry keeps the built-in service of an ID, so a community service
  // sharing it would never run.
  if ((RELEASE_BUILT_IN_SERVICE_IDS as readonly string[]).includes(manifest.id)) {
    problems.push(`Service id "${manifest.id}" belongs to a built-in service`);
  }
  for (const host of bareBuiltInHosts(manifest)) {
    problems.push(
      `Service "${manifest.id}" reaches built-in service "${host}" by its bare ID; use "${serviceNetworkAlias(host)}"`,
    );
  }
  // Both labels get the same sandbox; the schema already refuses "built-in" here.
  if (manifest.quality !== "community" && manifest.quality !== "community-verified") {
    problems.push(`Service "${manifest.id}" must declare a community quality`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.container.digest ?? "")) {
    problems.push(`Service "${manifest.id}" must pin its container image by sha256 digest`);
  }
  try {
    assertTrustedConfigurationSchema(manifest.configSchema);
  } catch (error) {
    problems.push(
      `Service "${manifest.id}" has an unsupported configuration schema: ${(error as Error).message}`,
    );
  }
  return problems;
}
