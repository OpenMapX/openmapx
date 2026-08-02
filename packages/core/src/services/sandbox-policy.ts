import { existsSync as fsExistsSync, realpathSync as fsRealpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { LoadedService, ManifestProvenance, ServiceManifest } from "./types";

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
  }
  if (m.exposure?.proxy?.enabled && !m.container.expose?.length) {
    errors.push(
      "exposure.proxy.enabled requires container.expose to declare at least one port for the proxy to route to",
    );
  }

  if (!hostPrivilegesAllowed) {
    // Third-party services may only bind paths from their own snapshot. Special
    // sources and Compose-variable paths can name platform-owned resources.
    for (const bm of m.bindMounts ?? []) {
      if (bm.source.startsWith("@")) {
        errors.push(
          `bindMounts: special source "${bm.source}" is only allowed for built-in services`,
        );
      }
      if (isComposeVarReference(bm.source) || isComposeVarReference(bm.target)) {
        errors.push(
          `bindMounts: Compose-variable paths ("${bm.source}") are not allowed for third-party services — the value is substituted from the deployment environment at stack-up time and can resolve to any host path`,
        );
      }
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

interface RenderFsHooks {
  existsSync: (path: string) => boolean;
  realpathSync: (path: string) => string;
}

/**
 * Resolve the longest existing ancestor through symlinks, then append the
 * non-existing tail lexically. This catches symlink escapes without requiring
 * the bind source itself to exist yet.
 */
function canonicalise(absPath: string, fs: RenderFsHooks): string {
  let head = absPath;
  const tail: string[] = [];
  while (!fs.existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return absPath;
    tail.unshift(basename(head));
    head = parent;
  }
  const resolvedHead = fs.realpathSync(head);
  return tail.length ? join(resolvedHead, ...tail) : resolvedHead;
}

/**
 * Cross-service and on-disk rules that need the whole registry and a real
 * filesystem. Throws on violation. Called by the renderer, which is the last
 * gate before a compose file is written.
 */
export function assertRenderSandbox(
  service: LoadedService,
  allServices: LoadedService[],
  fs?: RenderFsHooks,
): void {
  const staticErrors = checkManifestSandbox(service.manifest, {
    firstParty: service.isBuiltIn,
  });
  if (staticErrors.length) {
    throw new Error(
      `Service "${service.manifest.id}" failed sandbox validation: ${staticErrors.join("; ")}`,
    );
  }

  if (service.isBuiltIn) return;

  const fsHooks = fs ?? {
    existsSync: fsExistsSync,
    realpathSync: fsRealpathSync,
  };
  const serviceDir = canonicalise(service.directory, fsHooks);

  // This is checked at render time, so a symlink swapped between render and
  // `docker compose up` still wins. Making the community snapshot read-only is
  // deferred until the snapshot lifecycle is redesigned.
  for (const bm of service.manifest.bindMounts ?? []) {
    if (bm.source.startsWith("@") || isComposeVarReference(bm.source)) continue;
    const source = canonicalise(join(service.directory, bm.source), fsHooks);
    const fromService = relative(serviceDir, source);
    if (fromService.startsWith("..") || isAbsolute(fromService)) {
      throw new Error(
        `bindMount source "${bm.source}" on third-party service "${service.manifest.id}" escapes its service directory`,
      );
    }
  }

  const taken = new Map<string, string>();
  for (const other of allServices) {
    if (other.manifest.id === service.manifest.id) continue;
    taken.set(other.manifest.id, `service "${other.manifest.id}"`);
    for (const alias of other.manifest.container.networkAliases ?? []) {
      taken.set(alias, `network alias on service "${other.manifest.id}"`);
    }
  }
  for (const alias of service.manifest.container.networkAliases ?? []) {
    if (alias === service.manifest.id) continue;
    const owner = taken.get(alias);
    if (owner) {
      throw new Error(
        `network alias "${alias}" on third-party service "${service.manifest.id}" collides with ${owner}`,
      );
    }
  }

  const otherVolumeNames = new Map<string, string>();
  for (const other of allServices) {
    if (other.manifest.id === service.manifest.id) continue;
    for (const volume of other.manifest.volumes ?? []) {
      otherVolumeNames.set(volume.name, other.manifest.id);
    }
  }
  for (const volume of service.manifest.volumes ?? []) {
    const owner = otherVolumeNames.get(volume.name);
    if (owner) {
      throw new Error(
        `volume "${volume.name}" on third-party service "${service.manifest.id}" is already declared by service "${owner}"`,
      );
    }
  }
}
