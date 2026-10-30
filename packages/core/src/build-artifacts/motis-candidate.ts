/** Shared, data-only MOTIS candidate validation. No admission or lifecycle effects. */
import { realpathSync } from "node:fs";
import type { MotisConfigExpectations, MotisOperationsPolicy } from "@openmapx/transitous-core";
import { z } from "zod";
import { hashArtifactFile } from "./copy-tree";
import { AnchoredDirectory } from "./filesystem";
import { safeArtifactPath } from "./manifest";
export const CANDIDATE_MANIFEST_FILENAME = "motis-candidate-manifest.json";
export const CAPABILITY_SNAPSHOT_FILENAME = "mobility-capabilities.json";
export const CANDIDATE_PROXY_DIRNAME = ".openmapx-feed-proxy";
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

const count = z.number().int().nonnegative().safe();
const bounded = z.string().min(1).max(4096);
const artifact = z.strictObject({
  path: bounded.refine(safeArtifactPath),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: count,
});
const point = {
  fromLat: z.number().min(-90).max(90),
  fromLng: z.number().min(-180).max(180),
  toLat: z.number().min(-90).max(90),
  toLng: z.number().min(-180).max(180),
};
const identifiers = z.array(bounded).max(16384);
const policy = z.strictObject({
  profile: z.enum(["regional-assisted", "regional-sovereign", "planet"]),
  countries: identifiers,
  feedAllowList: identifiers,
  acquisition: z.enum(["mirror", "build"]),
  artifactOrigins: identifiers,
  originDownloadsRequired: z.boolean(),
  hostedRuntimeFallbackAllowed: z.boolean(),
  osmInput: bounded.optional(),
  gbfsSelection: z.enum(["explicit-countries", "explicit-feeds", "allow-listed-batches"]),
  maxFeedCount: count,
  retentionGenerations: count,
  resourceEnvelope: z.strictObject({
    minimumMemoryGb: z.number().nonnegative(),
    minimumCpu: z.number().nonnegative(),
    minimumDiskGb: z.number().nonnegative(),
    operatorCapacityRequired: z.boolean(),
  }),
  updateCadenceHours: z.number().nonnegative(),
  experimental: z.boolean(),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  epoch: z.string().min(1).max(128),
  createdAt: z.iso.datetime(),
  operationsPolicy: policy.optional(),
  expectations: z.strictObject({
    timetableDatasets: count,
    realtimeFeeds: count,
    gbfsFeeds: count,
    expectsGbfs: z.boolean(),
    tilesEnabled: z.boolean(),
    elevationEnabled: z.boolean(),
    routedTransfersEnabled: z.boolean(),
    gbfsProxyUrl: z.string().max(4096).nullable(),
    feedProxyUrls: identifiers,
  }),
  canary: z.strictObject({
    bbox: z.strictObject({
      minLat: z.number().min(-90).max(90),
      minLng: z.number().min(-180).max(180),
      maxLat: z.number().min(-90).max(90),
      maxLng: z.number().min(-180).max(180),
    }),
    plan: z.strictObject(point),
    expectedRentalProviderIds: identifiers,
    rentalPlan: z
      .strictObject({
        ...point,
        providerGroups: identifiers.optional(),
        providers: identifiers.optional(),
        formFactors: identifiers.optional(),
      })
      .optional(),
  }),
  artifacts: z.strictObject({
    config: artifact,
    license: artifact,
    proxyConfig: artifact,
    proxyVars: artifact,
    datasets: z.array(artifact).min(1).max(16384),
    sourceIndex: artifact.optional(),
    sourceManifest: artifact,
  }),
});
export function parseMotisCandidateManifest(text: string): MotisCandidateManifest {
  const result = manifestSchema.safeParse(JSON.parse(text));
  if (!result.success) throw Error("Unsupported or malformed candidate manifest");
  const manifest = result.data,
    a = manifest.artifacts;
  const fixed: [[string, string], ...[string, string][]] = [
    [a.config.path, "config.yml"],
    [a.license.path, "license.json"],
    [a.proxyConfig.path, `${CANDIDATE_PROXY_DIRNAME}/conf/default.conf`],
    [a.proxyVars.path, `${CANDIDATE_PROXY_DIRNAME}/feed-proxy-vars.json`],
    [a.sourceManifest.path, "transit-source-manifest.json"],
  ];
  if (
    fixed.some(([actual, expected]) => actual !== expected) ||
    (a.sourceIndex && a.sourceIndex.path !== "gbfs-source-index.json") ||
    a.datasets.some((file) => !/^[^.][^/]*\.(gtfs|netex)\.zip$/i.test(file.path))
  )
    throw Error("Candidate artifact inventory is invalid");
  const paths = [
    a.config,
    a.license,
    a.proxyConfig,
    a.proxyVars,
    ...a.datasets,
    ...(a.sourceIndex ? [a.sourceIndex] : []),
    a.sourceManifest,
  ].map((file) => file.path);
  if (new Set(paths).size !== paths.length)
    throw Error("Candidate artifact inventory contains duplicate paths");
  return manifest;
}
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
export function readCandidateManifest(stagingDir: string): MotisCandidateManifest {
  const root = new AnchoredDirectory(realpathSync(stagingDir));
  try {
    return parseMotisCandidateManifest(
      root.read(CANDIDATE_MANIFEST_FILENAME, MAX_MANIFEST_BYTES, false).toString("utf8"),
    );
  } finally {
    root.close();
  }
}
export async function verifyCandidateManifest(
  stagingDir: string,
  signal?: AbortSignal,
): Promise<MotisCandidateManifest> {
  signal?.throwIfAborted();
  const path = realpathSync(stagingDir),
    root = new AnchoredDirectory(path);
  try {
    const bytes = root.read(CANDIDATE_MANIFEST_FILENAME, MAX_MANIFEST_BYTES, false),
      manifest = parseMotisCandidateManifest(bytes.toString("utf8")),
      a = manifest.artifacts;
    for (const expected of [
      a.config,
      a.license,
      a.proxyConfig,
      a.proxyVars,
      ...a.datasets,
      ...(a.sourceIndex ? [a.sourceIndex] : []),
      a.sourceManifest,
    ]) {
      const current = await hashArtifactFile(root, expected.path, signal);
      if (current.sha256 !== expected.sha256 || current.sizeBytes !== expected.sizeBytes)
        throw Error(`Candidate artifact hash mismatch: ${expected.path}`);
    }
    signal?.throwIfAborted();
    if (
      realpathSync(stagingDir) !== path ||
      !root.read(CANDIDATE_MANIFEST_FILENAME, MAX_MANIFEST_BYTES, false).equals(bytes)
    )
      throw Error("Candidate manifest changed while verifying");
    return manifest;
  } finally {
    root.close();
  }
}
