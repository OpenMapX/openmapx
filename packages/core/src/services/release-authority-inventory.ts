import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type BuiltInServiceManifestSource,
  checkoutBuiltInServiceManifests,
  readRegularFileBytes,
} from "./built-in-service-source";
import { embeddedBuiltInServiceManifests } from "./embedded-built-in-services";
import { validateServiceManifest } from "./manifest-schema";
import type { LoadedService, ServiceManifest } from "./types";

export const RELEASE_BUILT_IN_SERVICE_IDS = Object.freeze([
  "app-api",
  "app-web",
  "brouter",
  "data-manager",
  "dawarich-app",
  "dawarich-postgis",
  "dawarich-redis",
  "dawarich-sidekiq",
  "elasticsearch",
  "local-ai",
  "martin",
  "motis",
  "motis-feed-proxy",
  "motis-staging",
  "nominatim",
  "ops-agent",
  "osrm",
  "otp",
  "overpass",
  "pelias",
  "pelias-pip",
  "pelias-placeholder",
  "photon",
  "postgis",
  "redis",
  "tileserver",
  "traefik",
  "transitous-runner",
  "valhalla",
  "well-known",
] as const);

export const RELEASE_NEVER_MANAGE_SERVICE_IDS = Object.freeze([
  "app-api",
  "ops-agent",
  "traefik",
] as const);

const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface ReleaseServiceAuthorityCapture {
  readonly serviceIds: readonly string[];
  readonly services: readonly LoadedService[];
  readonly digest: string;
}

export interface BuiltInServiceReadOptions {
  /**
   * Where the manifests are read from. Defaults to the release's copies
   * embedded in the runtime bundle, or to the checkout when running from
   * source.
   */
  source?: BuiltInServiceManifestSource;
}

/**
 * The built-in manifests this process runs: the release's own copies in the
 * ops-agent's runtime bundle, otherwise the checkout's (source, tests and the
 * host CLI, where the running code comes from that same checkout).
 */
export function builtInServiceManifestSource(rootDir: string): BuiltInServiceManifestSource {
  return (
    embeddedBuiltInServiceManifests() ??
    checkoutBuiltInServiceManifests(rootDir, RELEASE_BUILT_IN_SERVICE_IDS)
  );
}

function sourceIds(source: BuiltInServiceManifestSource): string[] {
  const ids = [...source.ids].sort();
  if (
    ids.some((id) => !SERVICE_ID.test(id)) ||
    new Set(ids).size !== ids.length ||
    RELEASE_NEVER_MANAGE_SERVICE_IDS.some((id) => !ids.includes(id))
  ) {
    throw new Error("invalid");
  }
  return ids;
}

/**
 * Reads and validates every built-in service manifest. Each service's
 * directory is still `<rootDir>/services/<id>`: Compose resolves its relative
 * bind mounts there, so configuration files keep coming from the checkout.
 * Throws on any missing, malformed or invalid manifest.
 */
export function readBuiltInServices(
  rootDir: string,
  options: BuiltInServiceReadOptions = {},
): ReleaseServiceAuthorityCapture {
  const source = options.source ?? builtInServiceManifestSource(rootDir);
  const servicesDir = join(resolve(rootDir), "services");
  const serviceIds = sourceIds(source);
  const services: LoadedService[] = [];
  const digest = createHash("sha256").update("openmapx-release-service-authority-v1\0");
  for (const id of serviceIds) {
    const bytes = readRegularFileBytes(source.manifestPath(id), MAX_MANIFEST_BYTES);
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const validation = validateServiceManifest(raw, { firstParty: true });
    if (!validation.valid || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("invalid");
    }
    if ((raw as Record<string, unknown>).id !== id) throw new Error("invalid");
    digest.update(id).update("\0").update(bytes).update("\0");
    services.push({
      manifest: raw as ServiceManifest,
      directory: join(servicesDir, id),
      isBuiltIn: true,
      enabled: true,
    });
  }
  return { serviceIds, services, digest: `release1_${digest.digest("base64url")}` };
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

/**
 * The built-in services this agent may render and run, as one immutable
 * snapshot. A bundled agent takes them from its release, so neither the
 * checkout's contents nor its file permissions decide what runs.
 */
export async function captureReleaseServiceAuthority(
  rootDir: string,
  options: BuiltInServiceReadOptions = {},
): Promise<ReleaseServiceAuthorityCapture> {
  try {
    const snapshot = readBuiltInServices(rootDir, options);
    deepFreeze(snapshot);
    return snapshot;
  } catch {
    throw new Error("Release service authority is unavailable");
  }
}

export async function validateReleaseServiceAuthority(rootDir: string): Promise<Set<string>> {
  const snapshot = await captureReleaseServiceAuthority(rootDir);
  return new Set(snapshot.serviceIds);
}

/** How the checkout's built-in services differ from the release's. */
export interface BuiltInServiceDrift {
  /** Release services the checkout has no manifest for. */
  readonly missing: readonly string[];
  /** Release services whose checkout manifest has different bytes or cannot be read. */
  readonly changed: readonly string[];
  /** Checkout service directories the release does not have. */
  readonly unexpected: readonly string[];
}

/**
 * Compares the checkout's built-in manifests with the release's embedded
 * ones. Returns `null` when running from source, where the checkout is the
 * source. Never throws: drift does not change what runs, the release's
 * manifests do, but configuration files still come from the checkout.
 */
export function inspectBuiltInServiceDrift(
  rootDir: string,
  source: BuiltInServiceManifestSource | null = embeddedBuiltInServiceManifests(),
): BuiltInServiceDrift | null {
  if (!source?.embedded) return null;
  const ids = [...source.ids].sort();
  const checkout = checkoutBuiltInServiceManifests(rootDir, ids);
  const missing: string[] = [];
  const changed: string[] = [];
  for (const id of ids) {
    let release: Buffer;
    let current: Buffer;
    try {
      release = readRegularFileBytes(source.manifestPath(id), MAX_MANIFEST_BYTES);
    } catch {
      changed.push(id);
      continue;
    }
    try {
      current = readRegularFileBytes(checkout.manifestPath(id), MAX_MANIFEST_BYTES);
    } catch (error) {
      ((error as NodeJS.ErrnoException).code === "ENOENT" ? missing : changed).push(id);
      continue;
    }
    if (!release.equals(current)) changed.push(id);
  }
  const unexpected: string[] = [];
  try {
    for (const entry of readdirSync(join(resolve(rootDir), "services"), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_") || !entry.isDirectory()) {
        continue;
      }
      if (!ids.includes(entry.name)) unexpected.push(entry.name);
    }
  } catch {
    // A checkout without services/ reports every release service as missing.
  }
  return { missing, changed, unexpected: unexpected.sort() };
}

/** One line for an operator, or `null` when the checkout matches the release. */
export function describeBuiltInServiceDrift(drift: BuiltInServiceDrift | null): string | null {
  if (!drift) return null;
  const parts = [
    drift.missing.length > 0 ? `missing ${drift.missing.join(", ")}` : null,
    drift.changed.length > 0 ? `changed ${drift.changed.join(", ")}` : null,
    drift.unexpected.length > 0 ? `not in this release ${drift.unexpected.join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return (
    `The checkout's built-in services differ from this release (${parts.join("; ")}). ` +
    "The release's service manifests apply; update the checkout to the selected release, " +
    "because the services still mount their configuration files from it."
  );
}
