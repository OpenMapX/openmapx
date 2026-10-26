import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  type BuiltInServiceManifestSource,
  checkoutBuiltInServiceManifests,
  readRegularFileBytes,
} from "./built-in-service-source";
import { embeddedBuiltInServiceManifests } from "./embedded-built-in-services";
import { validateServiceManifest } from "./manifest-schema";
import { type ReleaseServiceFiles, readEmbeddedReleaseServiceFiles } from "./release-service-files";
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
  /** The release's service files the digest covers; defaults to those the bundle embeds. */
  serviceFiles?: ReleaseServiceFiles | null;
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
  // The release's service files are part of what it runs: a bundle covers
  // their bytes, executable bits and every earlier version the import knows.
  // (Run from source, only tests pass an embedded source, without files.)
  const files =
    options.serviceFiles !== undefined
      ? options.serviceFiles
      : source.embedded
        ? readEmbeddedReleaseServiceFiles()
        : null;
  if (files) {
    digest.update("files\0");
    for (const file of files.files.values()) {
      digest
        .update(`${file.serviceId}/${file.path}`)
        .update("\0")
        .update(file.executable ? "x" : "-")
        .update("\0")
        .update(file.sha256)
        .update("\0");
    }
    digest.update("history\0");
    for (const [key, hashes] of [...files.history].sort(([a], [b]) => a.localeCompare(b))) {
      digest
        .update(key)
        .update("\0")
        .update([...hashes].sort().join(","))
        .update("\0");
    }
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
