import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { JobContext } from "./types.js";

export const TRANSIT_SOURCE_MANIFEST_FILENAME = "transit-source-manifest.json";

export interface TransitSourceManifestRecord {
  sourceId: string;
  region: string;
  name: string;
  format: "gtfs" | "netex";
  origin: "catalog" | "operator";
  originUrl?: string;
  license: Record<string, unknown>;
  transformations: string[];
  artifact: {
    relativePath: string;
    sha256: string;
    sizeBytes: number;
    modifiedAt: string;
  };
}

export interface TransitSourceManifest {
  version: 1;
  generatedAt: string;
  sources: TransitSourceManifestRecord[];
  profileEvidence?: {
    profile: string;
    credentialRefs?: string[];
  };
}

type DraftSource = Omit<TransitSourceManifestRecord, "artifact"> & {
  artifact?: TransitSourceManifestRecord["artifact"];
};
type DraftManifest = Omit<TransitSourceManifest, "sources"> & { sources: DraftSource[] };

function safeOriginUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  for (const key of url.searchParams.keys()) url.searchParams.set(key, "[redacted]");
  return url.toString();
}

function manifestPath(ctx: JobContext): string {
  return join(ctx.outDir, TRANSIT_SOURCE_MANIFEST_FILENAME);
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  const file = openSync(temporary, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function writeTransitSourceManifest(ctx: JobContext): string {
  const bySourceId = new Map<string, DraftSource>();
  for (const source of (ctx.state.selectedFeedFiles ?? []).flatMap(
    (feed) => feed.activeScheduleSources,
  )) {
    if (bySourceId.has(source.sourceId)) {
      throw new Error(`Duplicate desired transit source identity ${source.sourceId}`);
    }
    bySourceId.set(source.sourceId, {
      sourceId: source.sourceId,
      region: source.region,
      name: source.name,
      format: source.format,
      origin: source.origin,
      ...(source.originUrl ? { originUrl: safeOriginUrl(source.originUrl) } : {}),
      license: structuredClone(source.license ?? {}),
      transformations: ["transitous-fetch.py", "transitous-cleaning", "motis-config"],
    });
  }
  const credentialRefs = [
    ...(process.env.TRANSITOUS_API_KEYS_PATH ? ["TRANSITOUS_API_KEYS_PATH"] : []),
    ...(process.env.TRANSITOUS_FEED_PROXY_KEY_FILE ? ["TRANSITOUS_FEED_PROXY_KEY_FILE"] : []),
  ];
  const manifest: DraftManifest = {
    version: 1,
    generatedAt: ctx.now(),
    sources: [...bySourceId.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    profileEvidence: {
      profile: ctx.operationsPolicy.profile,
      ...(credentialRefs.length > 0 ? { credentialRefs } : {}),
    },
  };
  const path = manifestPath(ctx);
  atomicWrite(path, manifest);
  return path;
}

export function finalizeTransitSourceManifest(ctx: JobContext): string {
  const path = manifestPath(ctx);
  if (!existsSync(path)) throw new Error(`Transit source manifest missing at ${path}`);
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as DraftManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.sources)) {
    throw new Error(`Malformed transit source manifest at ${path}`);
  }
  for (const source of manifest.sources) {
    const artifact = [
      join(ctx.outDir, `${source.region}_${source.name}.${source.format}.zip`),
      join(ctx.outDir, `${source.region}_${source.name}.gtfs.zip`),
      join(ctx.outDir, `${source.region}_${source.name}.netex.zip`),
    ].find(existsSync);
    if (!artifact) {
      throw new Error(`Desired transit source ${source.sourceId} has no acquired artifact`);
    }
    const bytes = readFileSync(artifact);
    const stats = statSync(artifact);
    source.artifact = {
      relativePath: artifact.slice(ctx.outDir.length + 1),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      modifiedAt: stats.mtime.toISOString(),
    };
  }
  atomicWrite(path, manifest);
  return path;
}

export function readTransitSourceManifest(path: string): TransitSourceManifest {
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as DraftManifest;
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.sources) ||
    manifest.sources.some((source) => !source.artifact)
  ) {
    throw new Error(`Malformed or incomplete transit source manifest at ${path}`);
  }
  return manifest as TransitSourceManifest;
}
