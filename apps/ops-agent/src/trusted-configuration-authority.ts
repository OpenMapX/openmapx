import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import {
  TrustedAuthorityFilesystem,
  type TrustedAuthorityReadHooks,
} from "./trusted-authority-filesystem";
import type { TrustedConfigurationAuthoritySnapshot } from "./trusted-config-runtime";
import { assertTrustedConfigurationSchema } from "./trusted-config-schema";
import { loadTrustedIntegrationSchemas } from "./trusted-integration-registry";

const FAILED = "Trusted configuration authority rejected";
const REPOSITORY = /^[a-f0-9]{16}$/;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_REPOSITORIES = 256;
const MAX_DIRECTORIES = 4_096;
const MAX_DIRECTORY_ENTRIES = 2_048;
const MAX_MANIFESTS = 256;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TOTAL_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 4;
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "__pycache__",
]);

function readCommunityManifest(
  filesystem: TrustedAuthorityFilesystem,
  path: string,
  directory: string,
): { service: coreServices.LoadedService; bytes: Uint8Array } {
  const bytes = filesystem.readManifest(path, "service", MAX_MANIFEST_BYTES);
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  const validation = coreServices.validateServiceManifest(raw, { firstParty: false });
  if (!validation.valid || !raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(FAILED);
  }
  const manifest = raw as coreServices.ServiceManifest;
  if (
    !SERVICE_ID.test(manifest.id) ||
    manifest.quality !== "community" ||
    !/^sha256:[a-f0-9]{64}$/.test(manifest.container.digest ?? "")
  )
    throw new Error(FAILED);
  assertTrustedConfigurationSchema(manifest.configSchema);
  return {
    service: {
      manifest,
      directory: resolve(directory),
      isBuiltIn: false,
      enabled: true,
    },
    bytes,
  };
}

function loadCommunityServices(
  rootDir: string,
  filesystem: TrustedAuthorityFilesystem,
): { services: coreServices.LoadedService[]; manifestBytes: Uint8Array[] } {
  const servicesRoot = join(rootDir, "services");
  const community = join(servicesRoot, ".community");
  filesystem.openDirectory(servicesRoot);
  try {
    filesystem.openDirectory(community);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { services: [], manifestBytes: [] };
    }
    throw error;
  }
  const repositoryEntries = filesystem.listDirectory(community);
  const repositories = repositoryEntries.filter(
    (entry) => entry.isDirectory() && REPOSITORY.test(entry.name),
  );
  if (repositories.length > MAX_REPOSITORIES) throw new Error(FAILED);
  for (const entry of repositoryEntries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() || !REPOSITORY.test(entry.name)) throw new Error(FAILED);
  }

  const services: coreServices.LoadedService[] = [];
  const manifestBytes: Uint8Array[] = [];
  let directories = 0;
  let totalBytes = 0;
  const walk = (directory: string, depth: number): void => {
    directories += 1;
    if (directories > MAX_DIRECTORIES || depth > MAX_DEPTH) throw new Error(FAILED);
    filesystem.openDirectory(directory);
    const entries = filesystem.listDirectory(directory);
    if (entries.length > MAX_DIRECTORY_ENTRIES) throw new Error(FAILED);
    const manifestEntry = entries.find((entry) => entry.name === "service.json");
    if (manifestEntry) {
      const loaded = readCommunityManifest(filesystem, join(directory, "service.json"), directory);
      services.push(loaded.service);
      manifestBytes.push(loaded.bytes);
      totalBytes += loaded.bytes.byteLength;
      if (services.length > MAX_MANIFESTS || totalBytes > MAX_TOTAL_MANIFEST_BYTES) {
        throw new Error(FAILED);
      }
      return;
    }
    if (depth === MAX_DEPTH) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name))
        continue;
      walk(join(directory, entry.name), depth + 1);
    }
  };
  for (const repository of repositories.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    walk(join(community, repository.name), 0);
  }
  return { services, manifestBytes };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

export function createTrustedConfigurationAuthorityLoader(options: {
  rootDir: string;
  builtInServices: readonly coreServices.LoadedService[];
  builtInAuthorityDigest?: string;
  hooks?: TrustedAuthorityReadHooks;
}): () => Promise<TrustedConfigurationAuthoritySnapshot> {
  const builtInIds = new Set<string>();
  const builtIns = options.builtInServices.map((service) => {
    if (
      !service.isBuiltIn ||
      !SERVICE_ID.test(service.manifest.id) ||
      builtInIds.has(service.manifest.id)
    ) {
      throw new Error(FAILED);
    }
    builtInIds.add(service.manifest.id);
    assertTrustedConfigurationSchema(service.manifest.configSchema);
    return structuredClone(service);
  });
  return async () => {
    let filesystem: TrustedAuthorityFilesystem | undefined;
    try {
      filesystem = new TrustedAuthorityFilesystem(
        options.rootDir,
        process.geteuid?.() ?? 0,
        options.hooks,
      );
      const community = loadCommunityServices(options.rootDir, filesystem);
      const services = [
        ...builtIns.map((service) => structuredClone(service)),
        ...community.services,
      ];
      if (new Set(services.map((service) => service.manifest.id)).size !== services.length) {
        throw new Error(FAILED);
      }
      const integrationSchemas = loadTrustedIntegrationSchemas(options.rootDir, { filesystem });
      filesystem.recheck();
      const digest = createHash("sha256").update("openmapx-trusted-authority-v1\0");
      if (options.builtInAuthorityDigest) {
        if (!/^release1_[A-Za-z0-9_-]{43}$/.test(options.builtInAuthorityDigest)) {
          throw new Error(FAILED);
        }
        digest.update("fixed-release\0").update(options.builtInAuthorityDigest).update("\0");
      }
      for (const service of services.sort((left, right) =>
        left.manifest.id.localeCompare(right.manifest.id),
      )) {
        digest.update("service\0").update(service.manifest.id).update("\0");
        digest.update(canonicalJson(service.manifest)).update("\0");
      }
      for (const [id, schema] of [...integrationSchemas].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        digest
          .update("integration\0")
          .update(id)
          .update("\0")
          .update(canonicalJson(schema))
          .update("\0");
      }
      filesystem.recheck();
      const snapshot: TrustedConfigurationAuthoritySnapshot = {
        revisionId: `authority1_${digest.digest("base64url")}`,
        services,
        integrationSchemas,
      };
      deepFreeze(snapshot);
      return snapshot;
    } catch {
      throw new Error(FAILED);
    } finally {
      filesystem?.close();
    }
  };
}
