import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import type { TrustedConfigurationAuthoritySnapshot } from "./trusted-config-runtime";

const {
  assertTrustedConfigurationSchema,
  loadRecordedCommunityServices,
  loadTrustedIntegrationSchemas,
} = coreServices;
type TrustedAuthorityFilesystem = InstanceType<typeof coreServices.TrustedAuthorityFilesystem>;

const FAILED = "Trusted configuration authority rejected";
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
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

interface CommunityRepositoryService {
  service: coreServices.LoadedService;
  bytes: Uint8Array;
  /** Directory holding the manifest, relative to the repository root ("" for the root). */
  path: string;
}

/** The services a repository checkout provides, and why any of it would be rejected. */
export interface CommunityRepositoryReading {
  services: CommunityRepositoryService[];
  problems: string[];
}

/** Limits shared by every repository one authority snapshot reads. */
export interface CommunityReadBudget {
  directories: number;
  manifests: number;
  totalBytes: number;
}

function createCommunityReadBudget(): CommunityReadBudget {
  return { directories: 0, manifests: 0, totalBytes: 0 };
}

/**
 * Walk one repository checkout the way the authority snapshot does and read
 * every service manifest in it. A directory holding `service.json` is a
 * service; the walk does not descend below it. Problems are collected rather
 * than thrown, so a preview can explain them; the authority loader rejects a
 * checkout with any problem.
 */
export function readCommunityRepository(
  filesystem: TrustedAuthorityFilesystem,
  repositoryDirectory: string,
  budget: CommunityReadBudget = createCommunityReadBudget(),
): CommunityRepositoryReading {
  const services: CommunityRepositoryService[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  const walk = (directory: string, path: string, depth: number): boolean => {
    budget.directories += 1;
    if (budget.directories > MAX_DIRECTORIES) {
      problems.push(`The repository has more than ${MAX_DIRECTORIES} directories to search`);
      return false;
    }
    filesystem.openDirectory(directory);
    const entries = filesystem.listDirectory(directory);
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      problems.push(
        `${path || "The repository root"} has more than ${MAX_DIRECTORY_ENTRIES} entries`,
      );
      return false;
    }
    if (entries.some((entry) => entry.name === "service.json")) {
      const label = path ? `${path}/service.json` : "service.json";
      let bytes: Uint8Array;
      try {
        bytes = filesystem.readManifest(
          join(directory, "service.json"),
          "service",
          MAX_MANIFEST_BYTES,
        );
      } catch {
        problems.push(`${label} is not a regular file of at most ${MAX_MANIFEST_BYTES} bytes`);
        return true;
      }
      budget.manifests += 1;
      budget.totalBytes += bytes.byteLength;
      if (budget.manifests > MAX_MANIFESTS || budget.totalBytes > MAX_TOTAL_MANIFEST_BYTES) {
        problems.push(
          `Community services exceed ${MAX_MANIFESTS} manifests or ${MAX_TOTAL_MANIFEST_BYTES} bytes`,
        );
        return false;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        problems.push(`${label} is not valid UTF-8 JSON`);
        return true;
      }
      const manifestProblems = coreServices.communityServiceManifestProblems(raw);
      if (manifestProblems.length > 0) {
        for (const problem of manifestProblems) problems.push(`${label}: ${problem}`);
        return true;
      }
      const manifest = raw as coreServices.ServiceManifest;
      if (ids.has(manifest.id)) {
        problems.push(`${label}: service id "${manifest.id}" is declared more than once`);
        return true;
      }
      ids.add(manifest.id);
      services.push({
        service: { manifest, directory: resolve(directory), isBuiltIn: false, enabled: true },
        bytes,
        path,
      });
      return true;
    }
    if (depth === MAX_DEPTH) return true;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name))
        continue;
      if (
        !walk(join(directory, entry.name), path ? `${path}/${entry.name}` : entry.name, depth + 1)
      )
        return false;
    }
    return true;
  };
  walk(repositoryDirectory, "", 0);
  return { services, problems };
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
  hooks?: coreServices.TrustedAuthorityReadHooks;
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
    try {
      // Built-ins come from the release; community services only as the agent
      // recorded them, by digest; integration schemas from the release, plus
      // the checked installed ones. None of it rests on the checkout's file
      // permissions.
      const community = loadRecordedCommunityServices(options.rootDir).map(
        ({ service }) => service,
      );
      const services = [...builtIns.map((service) => structuredClone(service)), ...community];
      if (new Set(services.map((service) => service.manifest.id)).size !== services.length) {
        throw new Error(FAILED);
      }
      const integrationSchemas = loadTrustedIntegrationSchemas(options.rootDir, {
        ...(options.hooks ? { hooks: options.hooks } : {}),
      });
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
      const snapshot: TrustedConfigurationAuthoritySnapshot = {
        revisionId: `authority1_${digest.digest("base64url")}`,
        services,
        integrationSchemas,
      };
      deepFreeze(snapshot);
      return snapshot;
    } catch {
      throw new Error(FAILED);
    }
  };
}
