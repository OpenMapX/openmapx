import type { ManifestProvenance, ServiceManifest } from "./service-types";

// Compose-variable references are resolved from the deployment environment when
// Docker Compose starts the stack, not when OpenMapX renders it.
const COMPOSE_VAR_REFERENCE_REGEX = /^\$(\{[^{}]+\}|[A-Za-z_][A-Za-z0-9_]*)/;

export function isComposeVarReference(value: string): boolean {
  return COMPOSE_VAR_REFERENCE_REGEX.test(value);
}

// Capabilities that third-party services may request. This excludes capabilities
// that can trivially escape a container or affect the host kernel/devices.
export const COMMUNITY_SAFE_CAPS = new Set([
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "NET_BIND_SERVICE",
  "NET_RAW",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
]);

/**
 * Static, single-manifest sandbox rules. Returns error strings; an empty array
 * means the manifest is acceptable at its provenance level. Called by
 * `validateServiceManifest`, so it runs at registry load and at extension
 * clone-preview time.
 */
export function checkManifestSandbox(m: ServiceManifest, provenance: ManifestProvenance): string[] {
  const errors: string[] = [];
  const communityNetworkAccess = m.communityNetworkAccess;

  // The built-in tier and first-party provenance must agree. Enforcing both
  // directions means the tier is a pure function of where the manifest came
  // from, which is what lets the privilege gate below key on provenance alone.
  const declaresBuiltInTier = m.quality === "built-in";
  if (!provenance.firstParty && declaresBuiltInTier) {
    errors.push('quality: "built-in" is reserved for services shipped with the platform');
  }
  if (provenance.firstParty && !declaresBuiltInTier) {
    errors.push(`quality: a service under services/ must declare "built-in" (got "${m.quality}")`);
  }

  // Host-level privileges are an integrity decision, so only provenance answers
  // it. `quality` is a display label and never participates.
  const hostPrivilegesAllowed = provenance.firstParty;

  if (!hostPrivilegesAllowed && m.container.networkMode === "host") {
    errors.push("container.networkMode: 'host' is not allowed for community services");
  }
  if (!hostPrivilegesAllowed && communityNetworkAccess !== undefined) {
    errors.push(
      "community_network_access_forbidden: communityNetworkAccess is reserved for audited first-party services",
    );
  }
  if (
    !hostPrivilegesAllowed &&
    (m.privateNetworks !== undefined || m.platformNetwork !== undefined)
  ) {
    errors.push(
      "private_network_forbidden: privateNetworks and platformNetwork are reserved for audited first-party services",
    );
  }
  if (m.platformNetwork === false && !m.privateNetworks?.length) {
    errors.push("platformNetwork: false requires at least one privateNetworks entry");
  }
  if (
    m.container.networkMode === "host" &&
    (m.privateNetworks !== undefined || m.platformNetwork !== undefined)
  ) {
    errors.push(
      "container.networkMode: 'host' cannot be combined with privateNetworks or platformNetwork",
    );
  }
  if (!hostPrivilegesAllowed && m.container.privileged) {
    errors.push("container.privileged is not allowed for community services");
  }
  if (!hostPrivilegesAllowed) {
    for (const cap of m.container.capAdd ?? []) {
      if (!COMMUNITY_SAFE_CAPS.has(cap)) {
        errors.push(`container.capAdd: '${cap}' is not allowed for community services`);
      }
    }
    if (m.container.devices?.length) {
      errors.push("container.devices are not allowed for community services");
    }
    if (m.exposure?.proxy?.enabled) {
      errors.push(
        "community_proxy_forbidden: exposure.proxy.enabled is not allowed for community services",
      );
    }
  }
  if (m.exposure?.proxy?.enabled && !m.container.expose?.length) {
    errors.push(
      "exposure.proxy.enabled requires container.expose to declare at least one port for the proxy to route to",
    );
  }

  if (!hostPrivilegesAllowed) {
    if (m.bindMounts?.length) {
      errors.push(
        "community_bind_mount_forbidden: bindMounts are not allowed for community services",
      );
    }

    if (m.container.envFile?.length) {
      errors.push(
        "container.envFile is not allowed for third-party services — it resolves against infra/docker/ and would expose the deployment environment file. Declare operator-supplied values in configSchema instead; secret fields are delivered as /run/secrets/<KEY> with <KEY>_FILE set",
      );
    }

    for (const v of m.volumes ?? []) {
      if (!v.name.startsWith(`openmapx-${m.id}-`)) {
        errors.push(
          `volumes: "${v.name}" must be named "openmapx-${m.id}-<suffix>" for a third-party service, so it cannot attach a volume owned by the platform or another extension`,
        );
      }
    }
  }

  return errors;
}
