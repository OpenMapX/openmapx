import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobContext } from "./types.js";

export const SOVEREIGN_SOURCE_MANIFEST_FILENAME = "sovereign-source-manifest.json";

interface SovereignSourceRecord {
  id: string;
  originUrl: string;
  license: Record<string, unknown>;
  credentialReference?: string;
  transformations: string[];
  localArtifact?: { path: string; sha256: string; sizeBytes: number; retrievedAt: string };
}

interface SovereignSourceManifest {
  schemaVersion: 1;
  profile: "regional-sovereign";
  catalogDirectory: string;
  generatedAt: string;
  sources: SovereignSourceRecord[];
}

function safeOriginUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  for (const key of url.searchParams.keys()) url.searchParams.set(key, "[redacted]");
  return url.toString();
}

function manifestPath(ctx: JobContext): string {
  return join(ctx.outDir, SOVEREIGN_SOURCE_MANIFEST_FILENAME);
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(temporary, path);
}

export function writeSovereignSourceManifest(ctx: JobContext): string | null {
  if (ctx.operationsPolicy.profile !== "regional-sovereign") return null;
  const sources = (ctx.state.selectedFeedFiles ?? [])
    .flatMap((feed) => feed.activeScheduleSources)
    .map(
      (source): SovereignSourceRecord => ({
        id: source.id,
        originUrl: safeOriginUrl(source.originUrl ?? ""),
        license: structuredClone(source.license ?? {}),
        ...(process.env.TRANSITOUS_API_KEYS_PATH
          ? { credentialReference: "TRANSITOUS_API_KEYS_PATH" }
          : {}),
        transformations: ["transitous-fetch.py", "configured-feed-fixes"],
      }),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const manifest: SovereignSourceManifest = {
    schemaVersion: 1,
    profile: "regional-sovereign",
    catalogDirectory: ctx.catalogDir,
    generatedAt: ctx.now(),
    sources,
  };
  const path = manifestPath(ctx);
  atomicWrite(path, manifest);
  return path;
}

export function finalizeSovereignSourceManifest(ctx: JobContext): string | null {
  const path = manifestPath(ctx);
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as SovereignSourceManifest;
  for (const source of manifest.sources) {
    const artifact = [
      join(ctx.outDir, `${source.id}.gtfs.zip`),
      join(ctx.outDir, `${source.id}.netex.zip`),
    ].find(existsSync);
    if (!artifact) continue;
    const bytes = readFileSync(artifact);
    const stats = statSync(artifact);
    source.localArtifact = {
      path: artifact.slice(ctx.outDir.length + 1),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      retrievedAt: stats.mtime.toISOString(),
    };
  }
  atomicWrite(path, manifest);
  return path;
}
