import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrandArtifact, BrandEntry } from "./types";

export interface BrandIndex {
  entries: readonly BrandEntry[];
  byQid: ReadonlyMap<string, BrandEntry>;
  /** NSI version the artifact was generated from — surfaced in attribution. */
  source: string;
}

/**
 * Reads the committed artifact and builds the lookup index.
 *
 * The artifact is deliberately pre-normalized: `matchNames` are already
 * lowercase and diacritic-free, so loading is a parse plus a Map build rather
 * than a per-entry normalization pass. Callers should cache the result — see
 * `index.ts`.
 */
export function loadBrandIndex(): BrandIndex {
  const path = join(dirname(fileURLToPath(import.meta.url)), "data", "brands-index.json");
  const artifact = JSON.parse(readFileSync(path, "utf8")) as BrandArtifact;

  if (artifact.v !== 1) {
    throw new Error(`Unsupported brand artifact version: ${String(artifact.v)}`);
  }

  const byQid = new Map<string, BrandEntry>();
  for (const entry of artifact.brands) byQid.set(entry.qid, entry);

  return { entries: artifact.brands, byQid, source: artifact.source };
}
