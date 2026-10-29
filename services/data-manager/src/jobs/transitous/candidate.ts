import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  type MotisConfigExpectations,
  parseMotisConfigExpectations,
} from "@openmapx/transitous-core";
import { hashArtifactFile } from "../../../../../packages/core/src/build-artifacts/copy-tree";
import { AnchoredDirectory } from "../../../../../packages/core/src/build-artifacts/filesystem";
import { safeArtifactPath } from "../../../../../packages/core/src/build-artifacts/manifest";
import { atomicWriteJsonSync } from "../../utils/atomic-write.js";
import { GTFS_ARCHIVE_RE } from "./internal.js";
import type { MotisOperationsPolicy } from "./operations-profile.js";
import { TRANSIT_SOURCE_MANIFEST_FILENAME } from "./source-manifest.js";

export const CANDIDATE_MANIFEST_FILENAME = "motis-candidate-manifest.json";
export const CAPABILITY_SNAPSHOT_FILENAME = "mobility-capabilities.json";
export const CANDIDATE_PROXY_DIRNAME = ".openmapx-feed-proxy";

export type { MotisConfigExpectations } from "@openmapx/transitous-core";

export interface CandidateArtifactHash {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface MotisCandidateManifest {
  schemaVersion: 1;
  epoch: string;
  createdAt: string;
  operationsPolicy?: MotisOperationsPolicy;
  expectations: MotisConfigExpectations;
  canary: {
    bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number };
    plan: { fromLat: number; fromLng: number; toLat: number; toLng: number };
    expectedRentalProviderIds: string[];
    rentalPlan?: {
      fromLat: number;
      fromLng: number;
      toLat: number;
      toLng: number;
      providerGroups?: string[];
      providers?: string[];
      formFactors?: string[];
    };
  };
  artifacts: {
    config: CandidateArtifactHash;
    license: CandidateArtifactHash;
    proxyConfig: CandidateArtifactHash;
    proxyVars: CandidateArtifactHash;
    datasets: CandidateArtifactHash[];
    sourceIndex?: CandidateArtifactHash;
    sourceManifest: CandidateArtifactHash;
  };
}

export { parseMotisConfigExpectations } from "@openmapx/transitous-core";

export function sha256File(path: string, relativeTo?: string): CandidateArtifactHash {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw Error("Regular bounded candidate artifact required");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (BigInt(total) > before.size) throw Error("Candidate artifact changed while hashing");
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true }),
      named = lstatSync(path, { bigint: true });
    if (
      BigInt(total) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw Error("Candidate artifact changed while hashing");
    return {
      path: relativeTo ? path.slice(relativeTo.length + 1) : basename(path),
      sha256: hash.digest("hex"),
      sizeBytes: total,
    };
  } finally {
    closeSync(fd);
  }
}

function parseFloatSetting(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveCandidateCanary(): MotisCandidateManifest["canary"] {
  const canary: MotisCandidateManifest["canary"] = {
    bbox: {
      minLat: parseFloatSetting("MOTIS_HEALTH_BBOX_MIN_LAT", 52.515),
      minLng: parseFloatSetting("MOTIS_HEALTH_BBOX_MIN_LNG", 13.359),
      maxLat: parseFloatSetting("MOTIS_HEALTH_BBOX_MAX_LAT", 52.535),
      maxLng: parseFloatSetting("MOTIS_HEALTH_BBOX_MAX_LNG", 13.379),
    },
    plan: {
      fromLat: parseFloatSetting("MOTIS_HEALTH_PLAN_FROM_LAT", 52.525),
      fromLng: parseFloatSetting("MOTIS_HEALTH_PLAN_FROM_LNG", 13.369),
      toLat: parseFloatSetting("MOTIS_HEALTH_PLAN_TO_LAT", 48.14),
      toLng: parseFloatSetting("MOTIS_HEALTH_PLAN_TO_LNG", 11.558),
    },
    expectedRentalProviderIds: (process.env.MOTIS_HEALTH_RENTAL_PROVIDER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .sort(),
  };
  if (process.env.MOTIS_HEALTH_RENTAL_PLAN === "true") {
    const csv = (name: string): string[] | undefined => {
      const values = (process.env[name] ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      return values.length > 0 ? values.sort() : undefined;
    };
    canary.rentalPlan = {
      ...canary.plan,
      providerGroups: csv("MOTIS_HEALTH_RENTAL_PROVIDER_GROUPS"),
      providers: csv("MOTIS_HEALTH_RENTAL_PROVIDERS"),
      formFactors: csv("MOTIS_HEALTH_RENTAL_FORM_FACTORS"),
    };
  }
  return canary;
}

function createCandidateManifestWithHashes(
  stagingDir: string,
  epoch: string,
  createdAt: string,
  operationsPolicy: MotisOperationsPolicy | undefined,
  hashes: ReadonlyMap<string, CandidateArtifactHash>,
): MotisCandidateManifest {
  const hash = (path: string, _relativeTo: string) => {
    const result = hashes.get(path);
    if (!result) throw Error("Candidate artifact hash missing");
    return result;
  };
  const configPath = join(stagingDir, "config.yml");
  const licensePath = join(stagingDir, "license.json");
  const proxyRoot = join(stagingDir, CANDIDATE_PROXY_DIRNAME);
  const proxyConfigPath = join(proxyRoot, "conf", "default.conf");
  const proxyVarsPath = join(proxyRoot, "feed-proxy-vars.json");
  for (const required of [configPath, licensePath, proxyConfigPath, proxyVarsPath]) {
    if (!existsSync(required) || !statSync(required).isFile()) {
      throw new Error(`Required candidate artifact missing: ${required}`);
    }
  }
  const datasets = readdirSync(stagingDir)
    .filter((entry) => GTFS_ARCHIVE_RE.test(entry))
    .sort()
    .map((entry) => hash(join(stagingDir, entry), stagingDir));
  if (datasets.length === 0) throw new Error("Candidate contains no timetable datasets");
  const sourceIndexPath = join(stagingDir, "gbfs-source-index.json");
  const sourceManifestPath = join(stagingDir, TRANSIT_SOURCE_MANIFEST_FILENAME);
  if (!existsSync(sourceManifestPath)) {
    throw new Error(`Required candidate artifact missing: ${sourceManifestPath}`);
  }
  const manifest: MotisCandidateManifest = {
    schemaVersion: 1,
    epoch,
    createdAt,
    operationsPolicy,
    expectations: parseMotisConfigExpectations(readFileSync(configPath, "utf-8")),
    canary: resolveCandidateCanary(),
    artifacts: {
      config: hash(configPath, stagingDir),
      license: hash(licensePath, stagingDir),
      proxyConfig: hash(proxyConfigPath, stagingDir),
      proxyVars: hash(proxyVarsPath, stagingDir),
      datasets,
      ...(existsSync(sourceIndexPath) ? { sourceIndex: hash(sourceIndexPath, stagingDir) } : {}),
      sourceManifest: hash(sourceManifestPath, stagingDir),
    },
  };
  const output = join(stagingDir, CANDIDATE_MANIFEST_FILENAME);
  atomicWriteJsonSync(output, manifest, { durability: "full" });
  return manifest;
}

function candidateArtifactPaths(stagingDir: string): string[] {
  const required = [
    "config.yml",
    "license.json",
    `${CANDIDATE_PROXY_DIRNAME}/conf/default.conf`,
    `${CANDIDATE_PROXY_DIRNAME}/feed-proxy-vars.json`,
    TRANSIT_SOURCE_MANIFEST_FILENAME,
  ];
  for (const name of required)
    if (!existsSync(join(stagingDir, name)) || !statSync(join(stagingDir, name)).isFile())
      throw Error(`Required candidate artifact missing: ${name}`);
  if (statSync(join(stagingDir, "config.yml")).size > 32 * 1024 * 1024)
    throw Error("Candidate configuration exceeds its byte budget");
  const datasets = readdirSync(stagingDir)
    .filter((entry) => GTFS_ARCHIVE_RE.test(entry))
    .sort();
  if (!datasets.length || datasets.length > 16384)
    throw Error("Candidate contains no timetable datasets or exceeds its entry budget");
  return [
    ...required,
    ...datasets,
    ...(existsSync(join(stagingDir, "gbfs-source-index.json")) ? ["gbfs-source-index.json"] : []),
  ];
}
export function createCandidateManifest(
  stagingDir: string,
  epoch: string,
  createdAt: string,
  operationsPolicy?: MotisOperationsPolicy,
): MotisCandidateManifest {
  const hashes = new Map(
    candidateArtifactPaths(stagingDir).map((name) => [
      join(stagingDir, name),
      sha256File(join(stagingDir, name), stagingDir),
    ]),
  );
  return createCandidateManifestWithHashes(stagingDir, epoch, createdAt, operationsPolicy, hashes);
}
export async function createCandidateManifestAsync(
  stagingDir: string,
  epoch: string,
  createdAt: string,
  operationsPolicy?: MotisOperationsPolicy,
  signal?: AbortSignal,
): Promise<MotisCandidateManifest> {
  const root = new AnchoredDirectory(realpathSync(stagingDir));
  try {
    const hashes = new Map<string, CandidateArtifactHash>();
    for (const name of candidateArtifactPaths(stagingDir))
      hashes.set(join(stagingDir, name), await hashArtifactFile(root, name, signal));
    signal?.throwIfAborted();
    return createCandidateManifestWithHashes(
      stagingDir,
      epoch,
      createdAt,
      operationsPolicy,
      hashes,
    );
  } finally {
    root.close();
  }
}
export function readCandidateManifest(stagingDir: string): MotisCandidateManifest {
  const path = join(stagingDir, CANDIDATE_MANIFEST_FILENAME),
    root = new AnchoredDirectory(realpathSync(stagingDir));
  let manifest: MotisCandidateManifest;
  try {
    manifest = JSON.parse(
      root.read(CANDIDATE_MANIFEST_FILENAME, 32 * 1024 * 1024, false).toString("utf8"),
    );
  } catch {
    throw Error("Unsupported or malformed candidate manifest");
  } finally {
    root.close();
  }
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.epoch ||
    !manifest.artifacts ||
    !manifest.artifacts.sourceManifest
  ) {
    throw new Error(`Unsupported or malformed candidate manifest at ${path}`);
  }
  return manifest;
}

export function verifyCandidateManifest(stagingDir: string): MotisCandidateManifest {
  const manifest = readCandidateManifest(stagingDir);
  const artifacts = [
    manifest.artifacts.config,
    manifest.artifacts.license,
    manifest.artifacts.proxyConfig,
    manifest.artifacts.proxyVars,
    ...manifest.artifacts.datasets,
    ...(manifest.artifacts.sourceIndex ? [manifest.artifacts.sourceIndex] : []),
    manifest.artifacts.sourceManifest,
  ];
  for (const expected of artifacts) {
    const current = sha256File(join(stagingDir, expected.path), stagingDir);
    if (current.sha256 !== expected.sha256 || current.sizeBytes !== expected.sizeBytes) {
      throw new Error(`Candidate artifact hash mismatch: ${expected.path}`);
    }
  }
  return manifest;
}

export async function verifyCandidateManifestAsync(
  stagingDir: string,
  signal?: AbortSignal,
): Promise<MotisCandidateManifest> {
  const manifest = readCandidateManifest(stagingDir),
    root = new AnchoredDirectory(realpathSync(stagingDir));
  try {
    if (
      !Array.isArray(manifest.artifacts.datasets) ||
      manifest.artifacts.datasets.length === 0 ||
      manifest.artifacts.datasets.length > 16384
    )
      throw Error("Candidate dataset inventory is invalid");
    const artifacts = [
      manifest.artifacts.config,
      manifest.artifacts.license,
      manifest.artifacts.proxyConfig,
      manifest.artifacts.proxyVars,
      ...manifest.artifacts.datasets,
      ...(manifest.artifacts.sourceIndex ? [manifest.artifacts.sourceIndex] : []),
      manifest.artifacts.sourceManifest,
    ];
    for (const expected of artifacts) {
      if (!expected || typeof expected.path !== "string" || !safeArtifactPath(expected.path))
        throw Error("Candidate artifact path is invalid");
      const current = await hashArtifactFile(root, expected.path, signal);
      if (current.sha256 !== expected.sha256 || current.sizeBytes !== expected.sizeBytes)
        throw Error(`Candidate artifact hash mismatch: ${expected.path}`);
    }
    return manifest;
  } finally {
    root.close();
  }
}
