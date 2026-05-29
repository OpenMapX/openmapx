import { haversineMeters as haversineMetersCore } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { getParkingSourcePrefix, getParkingSourcePriority } from "./source-priority.js";

function facilityPriority(f: ParkingFacility): number {
  return getParkingSourcePriority(f.sources[0]);
}

// Clustering parameters
//
// Parking clustering deliberately widens past `DEDUP.PARKING_RADIUS_M`
// (25 m) + `DEDUP.NAME_SIMILARITY_MIN` (0.6) into a two-tier window —
// 40 m always, 40-150 m with name agreement — tuned for real-world
// parking sites that routinely span more than 25 m end to end.
/** Distance below which two facilities are considered the same regardless of name. */
const ALWAYS_MERGE_M = 40;
/** Distance above which two facilities are never merged. */
const NEVER_MERGE_M = 150;
/** At medium distances (40–150m), names must agree to this Jaccard-over-min score. */
const NAME_SIM_THRESHOLD = 0.5;

/**
 * Bucket cell size in degrees, applied to both latitude and longitude.
 * The longitude neighbour range is derived dynamically from latitude (see
 * `lngNeighborRange`) because a degree of longitude shrinks toward the poles.
 */
const BUCKET_DEG = 0.002;
const METERS_PER_DEG_LAT = 111_320;
/** Clamp cos(lat) to keep the neighbour range bounded near the poles. */
const MIN_LAT_COS = 0.01;

// Haversine distance

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  return haversineMetersCore(lat1, lng1, lat2, lng2);
}

// Name similarity

/**
 * Generic parking-related tokens stripped before comparing names. These appear
 * in most sources and would inflate similarity if counted.
 */
const NAME_STOPWORDS = new Set([
  "parkhaus",
  "parkplatz",
  "parkplaetze",
  "tiefgarage",
  "garage",
  "parking",
  "parkobjekt",
  "parkzone",
  "parken",
  "stellplatz",
  "stellplaetze",
  "lot",
  "carpark",
  "p+r",
  "pr",
  "park",
  "ride",
  "parkandride",
  "parkride",
  "hof",
  "platz",
  "strasse",
  "straße",
  "str",
  "center",
  "centre",
  "de",
  "der",
  "die",
  "das",
  "am",
  "an",
  "im",
  "in",
  "the",
  "a",
]);

function tokenizeName(name: string | undefined): string[] {
  if (!name) return [];
  return (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length >= 2 && !NAME_STOPWORDS.has(t),
  );
}

function nameSimilarity(a: string | undefined, b: string | undefined): number {
  const ta = tokenizeName(a);
  const tb = tokenizeName(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect++;
  return intersect / Math.min(setA.size, setB.size);
}

// Type compatibility

/**
 * On-street parking is a distinct physical category — merging it with a
 * garage or surface lot produces a nonsensical result. All other types may
 * overlap at ground level (garages often have a surface overflow lot).
 */
function typesCompatible(a: ParkingType, b: ParkingType): boolean {
  if (a === "unknown" || b === "unknown") return true;
  if (a === "on-street" || b === "on-street") return a === b;
  return true;
}

// Cluster predicate

function shouldCluster(a: ParkingFacility, b: ParkingFacility): boolean {
  if (!typesCompatible(a.parkingType, b.parkingType)) return false;
  const d = haversineMeters(a.coordinates, b.coordinates);
  if (d >= NEVER_MERGE_M) return false;
  if (d <= ALWAYS_MERGE_M) return true;
  return nameSimilarity(a.name, b.name) >= NAME_SIM_THRESHOLD;
}

// Union-find

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }
}

// Spatial bucketing

function bucketKey(f: ParkingFacility): string {
  const [lng, lat] = f.coordinates;
  const bx = Math.floor(lng / BUCKET_DEG);
  const by = Math.floor(lat / BUCKET_DEG);
  return `${bx},${by}`;
}

/**
 * How many longitude buckets away we must scan to be sure any pair within
 * NEVER_MERGE_M is visited. A degree of longitude is 111.32 km * cos(lat)
 * wide, so at 50°N a 0.002° bucket is only ~143m across — less than the
 * 150m threshold. In that case ±1 isn't enough; this widens the search.
 */
function lngNeighborRange(lat: number): number {
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), MIN_LAT_COS);
  const maxLngDiffDeg = NEVER_MERGE_M / (METERS_PER_DEG_LAT * cosLat);
  // +1 to absorb cell-boundary offsets (points at opposite edges of their buckets).
  return Math.ceil(maxLngDiffDeg / BUCKET_DEG) + 1;
}

function neighborKeys(key: string, lat: number): string[] {
  const [bx, by] = key.split(",").map(Number);
  const lngRange = lngNeighborRange(lat);
  const out: string[] = [];
  for (let dx = -lngRange; dx <= lngRange; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      out.push(`${bx + dx},${by + dy}`);
    }
  }
  return out;
}

// Field-level merge helpers

/**
 * Return the highest-priority member's value that passes `pick`, else
 * fall back to any member that does.
 */
function pickByPriority<T>(
  members: ParkingFacility[],
  pick: (m: ParkingFacility) => T | undefined | null,
): T | undefined {
  // members are already sorted by priority ascending
  for (const m of members) {
    const v = pick(m);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/**
 * Pick the longest non-empty string across members. Intended for descriptive
 * free-text fields (feeDescription, openingHours, address) where more text
 * generally means more useful detail.
 */
function pickRichestString(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const v of values) {
    if (!v) continue;
    if (best === undefined || v.length > best.length) best = v;
  }
  return best;
}

function pickRichestArray<T>(values: Array<T[] | undefined>): T[] | undefined {
  let best: T[] | undefined;
  for (const v of values) {
    if (!v || v.length === 0) continue;
    if (best === undefined || v.length > best.length) best = v;
  }
  return best;
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  let best: number | undefined;
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (best === undefined || v > best) best = v;
  }
  return best;
}

function minDefined(values: Array<number | undefined>): number | undefined {
  let best: number | undefined;
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (best === undefined || v < best) best = v;
  }
  return best;
}

/**
 * Collapse source strings to a canonical set for display. Keeps the primary's
 * full source (e.g. "parkapi-v2/Dresden") but deduplicates variants of the
 * same provider across the cluster.
 */
function dedupeSources(primary: string, all: string[]): string[] {
  const seen = new Map<string, string>(); // prefix → full label
  seen.set(getParkingSourcePrefix(primary), primary);
  for (const s of all) {
    const prefix = getParkingSourcePrefix(s);
    if (!seen.has(prefix)) seen.set(prefix, s);
  }
  return Array.from(seen.values());
}

function newestIsoString(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (time > bestTime) {
      best = value;
      bestTime = time;
    }
  }
  return best;
}

function uniqueStrings(values: Array<string[] | undefined>): string[] | undefined {
  const seen = new Set<string>();
  for (const arr of values) {
    for (const value of arr ?? []) {
      if (value) seen.add(value);
    }
  }
  return seen.size > 0 ? Array.from(seen) : undefined;
}

// Cluster merge

function mergeCluster(cluster: ParkingFacility[]): ParkingFacility {
  const members = [...cluster].sort((a, b) => facilityPriority(a) - facilityPriority(b));
  const primary = members[0];

  const realtimeMembers = members.filter((m) => m.hasRealtimeData);
  const realtime = realtimeMembers[0];

  const freeSpaces = realtime?.freeSpaces ?? pickByPriority(members, (m) => m.freeSpaces);

  const state =
    realtime?.state && realtime.state !== "unknown"
      ? realtime.state
      : (pickByPriority(members, (m) => (m.state && m.state !== "unknown" ? m.state : undefined)) ??
        primary.state);

  const parkingType: ParkingType =
    pickByPriority(members, (m) => (m.parkingType !== "unknown" ? m.parkingType : undefined)) ??
    "unknown";

  const fee =
    pickByPriority(members, (m) => (m.fee && m.fee !== "unknown" ? m.fee : undefined)) ??
    primary.fee;

  const allSources = members.flatMap((m) => m.sources);
  const dataUpdatedAt = newestIsoString(members.map((m) => m.dataUpdatedAt));
  const staticDataUpdatedAt = newestIsoString(members.map((m) => m.staticDataUpdatedAt));
  const realtimeDataUpdatedAt = newestIsoString(members.map((m) => m.realtimeDataUpdatedAt));
  const qualityWarnings = uniqueStrings(members.map((m) => m.qualityWarnings));

  return {
    id: primary.id,
    name: primary.name,
    coordinates: primary.coordinates,
    sources: dedupeSources(primary.sources[0], allSources),
    sourceUid: pickByPriority(members, (m) => m.sourceUid),
    sourceName: pickByPriority(members, (m) => m.sourceName),
    sourceUrl: pickByPriority(members, (m) => m.sourceUrl),
    sourceAttribution: pickByPriority(members, (m) => m.sourceAttribution),

    parkingType,
    hasRealtimeData: realtimeMembers.length > 0,
    freeSpaces,
    capacity: pickByPriority(members, (m) => m.capacity),
    state,
    dataUpdatedAt,
    staticDataUpdatedAt,
    realtimeDataUpdatedAt,
    isStale: members.some((m) => m.isStale) || undefined,
    qualityWarnings,

    // Richer info wins for accessibility/EV counts — operator-reported counts
    // are generally higher than equipment-tag sentinels (1).
    disabledSpaces: maxDefined(members.map((m) => m.disabledSpaces)),
    womenSpaces: maxDefined(members.map((m) => m.womenSpaces)),
    chargingSpaces: maxDefined(members.map((m) => m.chargingSpaces)),
    // Most restrictive height wins — safer for routing taller vehicles.
    maxHeight: minDefined(members.map((m) => m.maxHeight)),

    // Trend is intrinsically realtime telemetry (fill direction is only
    // meaningful when paired with current occupancy), so we restrict the
    // fallback to realtime-bearing members. A static-only member's stale
    // trend must never bleed into the merged facility.
    trend: pickByPriority(realtimeMembers, (m) => m.trend),

    fee,
    feeDescription: pickRichestString(members.map((m) => m.feeDescription)),
    tariffRows: pickRichestArray(members.map((m) => m.tariffRows)),

    access: pickByPriority(members, (m) => m.access),
    operator: pickByPriority(members, (m) => m.operator),
    address: pickRichestString(members.map((m) => m.address)),
    openingHours: pickRichestString(members.map((m) => m.openingHours)),

    parkAndRide: members.some((m) => m.parkAndRide) || undefined,
    nearestStation: pickByPriority(members, (m) => m.nearestStation),
    chargingDetails: pickRichestString(members.map((m) => m.chargingDetails)),
    paymentMethods: pickRichestString(members.map((m) => m.paymentMethods)),
    url: pickByPriority(members, (m) => m.url),
  };
}

// Public API

/**
 * Deduplicates and merges parking facilities by clustering nearby entries.
 *
 * Clustering uses haversine distance plus a name similarity gate to catch
 * same-site duplicates across sources without collapsing unrelated neighbours.
 * The whole cluster is merged in one pass (not pairwise), so field-level
 * choices see every member at once.
 */
export function deduplicateParking(facilities: ParkingFacility[]): ParkingFacility[] {
  const n = facilities.length;
  if (n === 0) return [];

  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = bucketKey(facilities[i]);
    const arr = buckets.get(key);
    if (arr) arr.push(i);
    else buckets.set(key, [i]);
  }

  const uf = new UnionFind(n);
  // Track each cluster's current members so we can enforce that every pair
  // within a cluster passes `shouldCluster`. Without this check, a chain
  // A↔B, B↔C could union A and C even when they lie beyond NEVER_MERGE_M.
  const clusterMembers = new Map<number, number[]>();
  for (let i = 0; i < n; i++) clusterMembers.set(i, [i]);

  for (let i = 0; i < n; i++) {
    const selfKey = bucketKey(facilities[i]);
    for (const nKey of neighborKeys(selfKey, facilities[i].coordinates[1])) {
      const candidates = buckets.get(nKey);
      if (!candidates) continue;
      for (const j of candidates) {
        if (j <= i) continue;
        if (!shouldCluster(facilities[i], facilities[j])) continue;
        const ri = uf.find(i);
        const rj = uf.find(j);
        if (ri === rj) continue;
        const ma = clusterMembers.get(ri);
        const mb = clusterMembers.get(rj);
        if (!ma || !mb) continue;
        // All pairs across the two clusters must also pass shouldCluster.
        // Cluster sizes are typically tiny (~1–5) so this is cheap.
        let ok = true;
        for (const a of ma) {
          for (const b of mb) {
            if (!shouldCluster(facilities[a], facilities[b])) {
              ok = false;
              break;
            }
          }
          if (!ok) break;
        }
        if (!ok) continue;
        uf.union(i, j);
        const newRoot = uf.find(i);
        const merged = [...ma, ...mb];
        if (newRoot !== ri) clusterMembers.delete(ri);
        if (newRoot !== rj) clusterMembers.delete(rj);
        clusterMembers.set(newRoot, merged);
      }
    }
  }

  const clusters = new Map<number, ParkingFacility[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const existing = clusters.get(root);
    if (existing) existing.push(facilities[i]);
    else clusters.set(root, [facilities[i]]);
  }

  const out: ParkingFacility[] = [];
  for (const cluster of clusters.values()) {
    out.push(cluster.length === 1 ? cluster[0] : mergeCluster(cluster));
  }
  return out;
}
