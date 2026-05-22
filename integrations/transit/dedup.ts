import { diceSimilarity, haversineMeters } from "@openmapx/core";
import type { TransitStop } from "@openmapx/mobility-core/transit";

export { diceSimilarity, haversineMeters };

// Name normalisation

const STRIP_TOKENS = new Set([
  "hbf",
  "hauptbahnhof",
  "station",
  "bahnhof",
  "gare",
  "central",
  "centraal",
  "estación",
  "estacion",
  "halte",
  "fermata",
  "arrêt",
  "arret",
  "stop",
  "terminal",
  "terminus",
  "haltepunkt",
  "hp",
  "metro",
  "u-bahn",
  "s-bahn",
]);

/** Parenthesised suffixes like "(tief)", "(S)", "(U)", "(Bus)". */
const PAREN_SUFFIX_RE = /\s*\([^)]*\)\s*/g;

/**
 * Lowercase a stop name, strip common transit suffixes / prefixes,
 * remove parenthesised tags, and collapse whitespace.
 */
export function normalizeName(name: string): string {
  let n = name.toLowerCase();

  // Strip parenthesised suffixes
  n = n.replace(PAREN_SUFFIX_RE, " ");

  // Tokenise, drop transit noise words, rejoin
  n = n
    .split(/[\s,/]+/)
    .filter((t) => t.length > 0 && !STRIP_TOKENS.has(t))
    .join(" ")
    .trim();

  return n;
}

// Route short-name normalisation

/** Standalone mode/service-type words that some providers prefix to route short names. */
const SHORT_NAME_MODE_PREFIX_RE =
  /^(bus|tram|ferry|fähre|straßenbahn|u-bahn|s-bahn|metro|subway|sneltrein|sprinter)\s+/i;

/**
 * Normalise a route short name for deduplication across providers.
 * - Strips parenthetical trip-number suffixes: "RB33 (Zug-Nr. 10323)" -> "RB33"
 * - Strips standalone mode-word prefixes: "Bus 73" -> "73"
 */
export function normalizeShortName(name: string): string {
  let n = name.trim();
  n = n.replace(/\s*\([^)]*\)\s*$/, ""); // drop "(...)" at end
  n = n.replace(SHORT_NAME_MODE_PREFIX_RE, ""); // drop "Bus ", "Tram ", ...
  return n.trim();
}

// Timestamp normalisation

/**
 * Normalise a departure timestamp to a canonical UTC ISO string for use in dedup keys.
 *
 * Different providers return the same moment in different formats:
 *   DB/HAFAS:   "2024-03-10T13:38:00.000+01:00"  (local time with offset)
 *   Transitous: "2024-03-10T12:38:00Z"            (UTC)
 *
 * String comparison of these would fail even though they represent the same instant.
 * Parsing via Date and re-serialising to ISO produces a canonical "...Z" string for both.
 */
export function normalizeTimestamp(ts: string): string {
  try {
    return new Date(ts).toISOString();
  } catch {
    return ts; // if unparseable, fall back to original to avoid dropping the entry
  }
}

/**
 * Return two adjacent 2-minute bucket keys for a timestamp.
 * This eliminates boundary issues: 22:41 produces buckets [22:40, 22:42]
 * and 22:42 also produces [22:42, 22:40], so they share the 22:40 bucket
 * regardless of which side of the boundary they fall on.
 */
export function bucketTimestamps(ts: string): [string, string] {
  try {
    const ms = new Date(ts).getTime();
    // TODO(policy): mobility-core's DEDUP.DEPARTURE_BUCKET_SECONDS is 60s.
    // This bucket is 120s to absorb realtime drift between providers for
    // the same trip; tightening to 60s would break inter-provider dedup.
    const BUCKET = 120_000; // 2 minutes
    const lower = Math.floor(ms / BUCKET) * BUCKET;
    const upper = lower + BUCKET;
    // Return the bucket this timestamp falls into AND the adjacent one
    // (whichever is closer: previous or next)
    const mid = lower + BUCKET / 2;
    const neighbor = ms < mid ? lower - BUCKET : upper;
    return [new Date(lower).toISOString(), new Date(neighbor).toISOString()];
  } catch {
    return [ts, ts];
  }
}

/**
 * Normalise a headsign for dedup comparison.
 * Sorts tokens alphabetically so "Koniglicher Hof, Moers" and
 * "Moers Koniglicher Hof" produce the same key.
 */
export function normalizeHeadsign(headsign: string): string {
  return normalizeName(headsign).split(" ").sort().join(" ");
}

// Trip number detection

/**
 * Returns true if `shortName` looks like an internal trip number rather than a
 * passenger-facing line name. These should not appear in the routes list.
 *
 * Heuristics (applied after stripping parenthetical suffixes):
 *   - 5+ pure digits: "26416", "30021"
 *   - Known train-type prefix + 4+ digit suffix: "RB 10325", "RE18935"
 *     (real line names use short numbers: "RB33", "RE4", "RE18", "IC2")
 */
export function isTripNumber(shortName: string): boolean {
  // Strip parenthetical suffix and whitespace
  const n = shortName
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, "");

  // 5+ pure digits
  if (/^\d{5,}$/.test(n)) return true;

  // Train-type prefix + 4+ digit number
  const m = n.match(/^(RB|RE|IC|ICE|EC|EN|IRE|MEX|TGV|THA|EIC|EX|CNL|NJ|RJ|RJX|EST)\d+$/i);
  if (m) {
    const digits = n.replace(/^[A-Za-z]+/, "");
    if (digits.length >= 4) return true;
  }

  return false;
}

// Deduplication
//
// TODO(policy): mobility-core's DEDUP.STOP_RADIUS_M is 50m and
// DEDUP.NAME_SIMILARITY_MIN is 0.6. Transit-stop clustering uses a
// wider 300m window with a more permissive 0.5 Dice floor because
// platforms of one logical station can sit hundreds of metres apart
// (e.g. opposite-direction bus stops, S/U-Bahn entrances). Tightening
// to policy would drop legitimate same-station dedup; kept raw until
// thresholds are reconciled.
const MAX_DISTANCE_M = 300;
const MIN_DICE = 0.5;

/** Default priority when no resolver is provided (lower = higher priority). */
const DEFAULT_PRIORITY = 10;

/**
 * Deduplicate transit stops that refer to the same physical station.
 *
 * Two stops are considered duplicates when **both** of these hold:
 *   1. They are within 300 m (haversine).
 *   2. Their normalised names have a Dice similarity >= 0.5.
 *
 * Among duplicates the stop from the highest-priority provider is kept.
 *
 * @param stops - Stops to deduplicate
 * @param priorityResolver - Optional function that returns a numeric priority
 *   for a provider name (lower = higher priority). When omitted, all providers
 *   get equal priority and the first stop encountered wins.
 */
export function deduplicateStops(
  stops: TransitStop[],
  priorityResolver?: (provider: string) => number,
): TransitStop[] {
  if (stops.length <= 1) return stops;

  const getPriority = priorityResolver ?? (() => DEFAULT_PRIORITY);

  // Sort by provider priority (best first) so the cluster representative
  // is always the highest-priority stop.
  const sorted = [...stops].sort((a, b) => getPriority(a.provider) - getPriority(b.provider));

  // Pre-compute normalised names
  const normNames = sorted.map((s) => normalizeName(s.name));

  // Union-Find to cluster duplicates
  const parent = sorted.map((_, i) => i);

  function find(x: number): number {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // Path compression
    let c = x;
    while (c !== r) {
      const next = parent[c];
      parent[c] = r;
      c = next;
    }
    return r;
  }

  function unite(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Always make the lower index the root to preserve priority ordering
    // (array is pre-sorted by provider priority, so lower index = higher priority)
    if (ra < rb) {
      parent[rb] = ra;
    } else {
      parent[ra] = rb;
    }
  }

  // Pairwise comparison — O(n^2) but n is small (nearby stops query)
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const dist = haversineMeters(sorted[i].lat, sorted[i].lng, sorted[j].lat, sorted[j].lng);
      if (dist > MAX_DISTANCE_M) continue;

      const sim = diceSimilarity(normNames[i], normNames[j]);
      if (sim >= MIN_DICE) {
        unite(i, j);
      }
    }
  }

  // Pick the best representative per cluster (lowest index = best priority
  // because we pre-sorted).
  const bestByRoot = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) {
    const root = find(i);
    if (!bestByRoot.has(root)) {
      bestByRoot.set(root, i);
    }
  }

  const keepIndices = new Set(bestByRoot.values());
  return sorted.filter((_, i) => keepIndices.has(i));
}
