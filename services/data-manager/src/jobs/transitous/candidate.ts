import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type MotisConfigExpectations,
  parseMotisConfigExpectations,
} from "@openmapx/transitous-core";
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
  const bytes = readFileSync(path);
  return {
    path: relativeTo ? path.slice(relativeTo.length + 1) : basename(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
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

export function createCandidateManifest(
  stagingDir: string,
  epoch: string,
  createdAt: string,
  operationsPolicy?: MotisOperationsPolicy,
): MotisCandidateManifest {
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
    .map((entry) => sha256File(join(stagingDir, entry), stagingDir));
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
      config: sha256File(configPath, stagingDir),
      license: sha256File(licensePath, stagingDir),
      proxyConfig: sha256File(proxyConfigPath, stagingDir),
      proxyVars: sha256File(proxyVarsPath, stagingDir),
      datasets,
      ...(existsSync(sourceIndexPath)
        ? { sourceIndex: sha256File(sourceIndexPath, stagingDir) }
        : {}),
      sourceManifest: sha256File(sourceManifestPath, stagingDir),
    },
  };
  const output = join(stagingDir, CANDIDATE_MANIFEST_FILENAME);
  atomicWriteJsonSync(output, manifest, { durability: "full" });
  return manifest;
}

export function readCandidateManifest(stagingDir: string): MotisCandidateManifest {
  const path = join(stagingDir, CANDIDATE_MANIFEST_FILENAME);
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as MotisCandidateManifest;
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
