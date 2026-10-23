import { createHash } from "node:crypto";
import { type BigIntStats, existsSync, readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, atomicWriteJsonSync } from "../../utils/atomic-write.js";
import { type GtfsArchiveSnapshot, scanGtfsArchives } from "./internal.js";
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

export function safeOriginUrl(raw: string | undefined): string | undefined {
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
      ...(source.origin === "catalog" && source.originUrl
        ? { originUrl: safeOriginUrl(source.originUrl) }
        : {}),
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
  atomicWriteJsonSync(path, manifest, { durability: "full" });
  return path;
}

/** Fixed read size: bounds per-artifact allocation however large the archive is. */
const HASH_CHUNK_BYTES = 64 * 1024;

type ArtifactFacts = TransitSourceManifestRecord["artifact"];

function sameArtifact(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** Same float-millisecond rounding as `Stats.mtime`; `BigIntStats.mtime` truncates instead. */
function modifiedAtIso(mtimeNs: bigint): string {
  const seconds = Number(mtimeNs / 1_000_000_000n);
  const nanoseconds = Number(mtimeNs % 1_000_000_000n);
  return new Date(seconds * 1e3 + nanoseconds / 1e6).toISOString();
}

/**
 * Hashes one archive through a single owned descriptor in fixed-size
 * asynchronous reads so timers and HTTP keep running between chunks. The
 * digest, size and mtime all describe the opened file; a file that changes or
 * is replaced while it is read is rejected instead of recorded.
 */
async function hashArtifact(
  path: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<ArtifactFacts> {
  signal.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let position = 0n;
    while (position < before.size) {
      signal.throwIfAborted();
      const wanted = Number(
        before.size - position < BigInt(HASH_CHUNK_BYTES)
          ? before.size - position
          : BigInt(HASH_CHUNK_BYTES),
      );
      const { bytesRead } = await handle.read(buffer, 0, wanted, position);
      if (bytesRead === 0) {
        throw new Error(`Transit source artifact ${relativePath} was truncated while being hashed`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += BigInt(bytesRead);
    }
    signal.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    const onPath = await stat(path, { bigint: true });
    if (!sameArtifact(before, after) || !sameArtifact(before, onPath)) {
      throw new Error(`Transit source artifact ${relativePath} changed while being hashed`);
    }
    return {
      relativePath,
      sha256: hash.digest("hex"),
      sizeBytes: Number(position),
      modifiedAt: modifiedAtIso(before.mtimeNs),
    };
  } finally {
    await handle.close();
  }
}

export async function finalizeTransitSourceManifest(ctx: JobContext): Promise<string> {
  const path = manifestPath(ctx);
  if (!existsSync(path)) throw new Error(`Transit source manifest missing at ${path}`);
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as DraftManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.sources)) {
    throw new Error(`Malformed transit source manifest at ${path}`);
  }
  const archivesById = new Map<string, GtfsArchiveSnapshot[]>();
  for (const archive of scanGtfsArchives(ctx.outDir)) {
    const id = archive.id.toLowerCase();
    const group = archivesById.get(id);
    if (group) group.push(archive);
    else archivesById.set(id, [archive]);
  }
  for (const source of manifest.sources) {
    const artifactStem = `${source.region}_${source.name}`.toLowerCase();
    const matches = archivesById.get(artifactStem) ?? [];
    const preferredFormats = [source.format, source.format === "gtfs" ? "netex" : "gtfs"];
    let artifact: string | undefined;
    for (const format of preferredFormats) {
      const formatMatches = matches.filter((archive) => archive.path.endsWith(`.${format}.zip`));
      if (formatMatches.length > 1) {
        throw new Error(
          `Desired transit source ${source.sourceId} has ambiguous ${format} artifacts`,
        );
      }
      if (formatMatches[0]) {
        artifact = formatMatches[0].path;
        break;
      }
    }
    if (!artifact) {
      throw new Error(`Desired transit source ${source.sourceId} has no acquired artifact`);
    }
    // The acquired artifact is authoritative for the format: a mirror
    // gtfs-to-netex fallback must not be recorded as a gtfs artifact.
    if (artifact.endsWith(".netex.zip")) source.format = "netex";
    else if (artifact.endsWith(".gtfs.zip")) source.format = "gtfs";
    source.artifact = await hashArtifact(
      artifact,
      artifact.slice(ctx.outDir.length + 1),
      ctx.abortSignal,
    );
  }
  ctx.abortSignal.throwIfAborted();
  await atomicWriteFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { durability: "full" });
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
