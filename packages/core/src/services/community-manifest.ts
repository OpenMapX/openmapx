import { assertTrustedConfigurationSchema } from "./configuration-schema";
import { serviceNetworkAlias } from "./core-service-ids";
import { validateServiceManifest } from "./manifest-schema";
import { RELEASE_BUILT_IN_SERVICE_IDS } from "./release-authority-inventory";
import type { ServiceManifest } from "./types";

const COMMUNITY_SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The host of a URL (`http://host:port`) or of a userinfo address (`user@host:port`). */
const URL_HOST = /(?:\/\/|@)([A-Za-z0-9][A-Za-z0-9.-]*)(?=[:/?#]|$)/g;

/**
 * The built-in services a community manifest addresses by bare ID in its
 * environment, command or configuration defaults. A bridge network carries
 * the bare ID too, but platform traffic uses only `openmapx-<service-id>`.
 */
function bareBuiltInHosts(manifest: ServiceManifest): string[] {
  const { container } = manifest;
  const listed = (value: string[] | string | undefined) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  const defaults = Object.values(
    (manifest.configSchema?.properties ?? {}) as Record<string, { default?: unknown }>,
  ).flatMap((property) => (typeof property?.default === "string" ? [property.default] : []));
  const values = [
    ...Object.values(container.environment ?? {}),
    ...listed(container.command),
    ...listed(container.entrypoint),
    ...defaults,
  ];
  const builtIn = new Set<string>(RELEASE_BUILT_IN_SERVICE_IDS);
  const hosts = new Set<string>();
  for (const value of values)
    for (const match of value.matchAll(URL_HOST)) {
      const host = match[1]?.toLowerCase();
      if (host && builtIn.has(host)) hosts.add(host);
    }
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
