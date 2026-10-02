import { createHash } from "node:crypto";
import type { PoiRow } from "./types.js";

/** Object keys are unordered in jsonb; array order remains meaningful. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Server-only full-publication comparison. Bump version when a deliberate
 * rebuild is required independently of normalized content. Match JSON storage
 * semantics (toJSON, omitted undefined fields, non-finite values) before sorting.
 */
export function createStaticPoiChangeKey(version: string): (rows: readonly PoiRow[]) => string {
  return (rows) => {
    const normalized = rows
      .map((row) => {
        // Persistence stringifies each payload at the root, so toJSON must
        // receive the same key before the payload becomes part of a tuple.
        const payload = JSON.parse(JSON.stringify(row.payload));
        return canonicalJson(JSON.parse(JSON.stringify([row.poiId, row.lng, row.lat, payload])));
      })
      .sort();
    const hash = createHash("sha256").update(JSON.stringify(["static-poi-v1", version]));
    for (const row of normalized) hash.update("\n").update(row);
    return hash.digest("hex");
  };
}
