import type { PoiSearchResult } from "@openmapx/integration-framework";
import { diceSimilarity, haversineMeters } from "./geo-server";

export interface ConflationPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category?: string;
}

export interface ConflationThresholds {
  alwaysMergeM: number;
  softWindowM: number;
  nameDiceFloor: number;
}

export interface ConflationResult {
  matched: Array<{ a: ConflationPoint; b: ConflationPoint }>;
  unmatchedA: ConflationPoint[];
  unmatchedB: ConflationPoint[];
}

/**
 * Provisional defaults pending conflation-precision calibration against a
 * hand-labeled ground-truth sample. Adjust via thresholds parameter if needed.
 */
export const DEFAULT_CONFLATION_THRESHOLDS: ConflationThresholds = {
  alwaysMergeM: 25,
  softWindowM: 120,
  nameDiceFloor: 0.8,
};

const BUCKET_DEG = 0.002;
const METERS_PER_DEG_LAT = 111_320;
const MIN_LAT_COS = 0.01;

function bucketKey(lat: number, lng: number): string {
  return `${Math.floor(lng / BUCKET_DEG)},${Math.floor(lat / BUCKET_DEG)}`;
}

function lngNeighborRange(lat: number, maxDistM: number): number {
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), MIN_LAT_COS);
  const maxLngDiffDeg = maxDistM / (METERS_PER_DEG_LAT * cosLat);
  return Math.ceil(maxLngDiffDeg / BUCKET_DEG) + 1;
}

function neighborKeys(key: string, lat: number, maxDistM: number): string[] {
  const [bx, by] = key.split(",").map(Number);
  const lngRange = lngNeighborRange(lat, maxDistM);
  const out: string[] = [];
  for (let dx = -lngRange; dx <= lngRange; dx++) {
    for (let dy = -1; dy <= 1; dy++) out.push(`${bx + dx},${by + dy}`);
  }
  return out;
}

function categoryCompatible(a: ConflationPoint, b: ConflationPoint): boolean {
  if (a.category === undefined || b.category === undefined) return true;
  return a.category === b.category;
}

function shouldMatch(a: ConflationPoint, b: ConflationPoint, t: ConflationThresholds): boolean {
  const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  if (d > t.softWindowM) return false;
  if (d <= t.alwaysMergeM) return true;
  return diceSimilarity(a.name, b.name) >= t.nameDiceFloor && categoryCompatible(a, b);
}

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

/**
 * Bipartite conflation of two POI sets: a (e.g. OSM) vs b (e.g. Overture).
 *
 * Generalizes the union-find pattern from deduplicateChargingStations for a
 * cross-set (bipartite) match rather than within-set dedup:
 *   - ≤ alwaysMergeM: always match
 *   - > alwaysMergeM and ≤ softWindowM: match iff name dice ≥ nameDiceFloor
 *     AND categories are compatible
 *   - > softWindowM: never match
 *
 * Exhaustive pairwise validation prevents transitive chaining: before merging
 * two clusters, every pair (one from each cluster) must individually satisfy
 * the shouldMatch predicate.
 *
 * Each point matches at most once (bipartite constraint enforced by tracking
 * matched indices per side after union-find resolves).
 */
export function conflate(
  a: ConflationPoint[],
  b: ConflationPoint[],
  t: ConflationThresholds,
): ConflationResult {
  if (a.length === 0 && b.length === 0) {
    return { matched: [], unmatchedA: [], unmatchedB: [] };
  }
  if (a.length === 0) {
    return { matched: [], unmatchedA: [], unmatchedB: [...b] };
  }
  if (b.length === 0) {
    return { matched: [], unmatchedA: [...a], unmatchedB: [] };
  }

  const na = a.length;
  const nb = b.length;
  const total = na + nb;

  // Index a as 0..na-1, b as na..na+nb-1
  const uf = new UnionFind(total);
  const clusterMembers = new Map<number, number[]>();
  for (let i = 0; i < total; i++) clusterMembers.set(i, [i]);

  function getPoint(idx: number): ConflationPoint {
    return idx < na ? a[idx] : b[idx - na];
  }

  function isA(idx: number): boolean {
    return idx < na;
  }

  // Build spatial buckets for b-side points
  const bBuckets = new Map<string, number[]>();
  for (let j = 0; j < nb; j++) {
    const key = bucketKey(b[j].lat, b[j].lng);
    const arr = bBuckets.get(key);
    if (arr) arr.push(j);
    else bBuckets.set(key, [j]);
  }

  for (let i = 0; i < na; i++) {
    const selfKey = bucketKey(a[i].lat, a[i].lng);
    for (const nKey of neighborKeys(selfKey, a[i].lat, t.softWindowM)) {
      const candidates = bBuckets.get(nKey);
      if (!candidates) continue;
      for (const jRel of candidates) {
        const j = na + jRel;
        if (!shouldMatch(a[i], b[jRel], t)) continue;

        const ri = uf.find(i);
        const rj = uf.find(j);
        if (ri === rj) continue;

        const ma = clusterMembers.get(ri);
        const mb = clusterMembers.get(rj);
        if (!ma || !mb) continue;

        // Exhaustive pairwise validation across clusters
        let ok = true;
        outer: for (const x of ma) {
          for (const y of mb) {
            if (isA(x) === isA(y)) continue; // same side — no cross-check needed
            const pa = isA(x) ? getPoint(x) : getPoint(y);
            const pb = isA(x) ? getPoint(y) : getPoint(x);
            if (!shouldMatch(pa, pb, t)) {
              ok = false;
              break outer;
            }
          }
        }
        if (!ok) continue;

        uf.union(i, j);
        const root = uf.find(i);
        const merged = [...ma, ...mb];
        if (root !== ri) clusterMembers.delete(ri);
        if (root !== rj) clusterMembers.delete(rj);
        clusterMembers.set(root, merged);
      }
    }
  }

  // Collect results: a cluster that spans both sides = a match
  const matched: Array<{ a: ConflationPoint; b: ConflationPoint }> = [];
  const matchedAIdx = new Set<number>();
  const matchedBIdx = new Set<number>();

  for (const members of clusterMembers.values()) {
    const aMembers = members.filter((idx) => isA(idx));
    const bMembers = members.filter((idx) => !isA(idx));
    if (aMembers.length === 0 || bMembers.length === 0) continue;
    // Bipartite: pick the best a-b pair (closest by index = first found)
    // For the spike, pick first a × first b and leave remaining unmatched.
    const pa = a[aMembers[0]];
    const pb = b[bMembers[0] - na];
    matched.push({ a: pa, b: pb });
    matchedAIdx.add(aMembers[0]);
    matchedBIdx.add(bMembers[0] - na);
    // Remaining in this cluster are left unmatched (bipartite constraint)
  }

  const unmatchedA = a.filter((_, i) => !matchedAIdx.has(i));
  const unmatchedB = b.filter((_, j) => !matchedBIdx.has(j));

  return { matched, unmatchedA, unmatchedB };
}

/**
 * Derives the link-table key (`${osm_type}/${osm_id}`) from an OSM result id.
 * OSM results use the format `osm:${type}/${id}` (e.g. `osm:node/1234`).
 * Returns null when the id does not follow this pattern.
 */
function osmResultLinkKey(id: string): string | null {
  if (!id.startsWith("osm:")) return null;
  const rest = id.slice(4);
  if (!rest.includes("/")) return null;
  return rest;
}

/**
 * Applies the same fusion rules as the union-find path: OSM wins core fields,
 * Overture gap-fills brand/category, carries gersId. Extracted so both the
 * link-first pass and the union-find path produce identical output for a matched
 * OSM↔Overture pair.
 */
function fuseOsmOverturePair(osmR: PoiSearchResult, overtR: PoiSearchResult): PoiSearchResult {
  const overtureBrandTags: Record<string, string> = {};
  if (overtR.osmTags?.brand) overtureBrandTags.brand = overtR.osmTags.brand;
  if (overtR.osmTags?.["brand:wikidata"])
    overtureBrandTags["brand:wikidata"] = overtR.osmTags["brand:wikidata"];
  return {
    ...osmR,
    gersId: overtR.gersId ?? overtR.id,
    name: osmR.name ?? overtR.name,
    coordinates: osmR.coordinates,
    openingHours: osmR.openingHours ?? overtR.openingHours,
    phone: osmR.phone ?? overtR.phone,
    category: osmR.category ?? overtR.category,
    osmTags: { ...osmR.osmTags, ...overtureBrandTags },
  };
}

/**
 * Fuses OSM and Overture POI results.
 *
 * When a precomputed `link` map is supplied (keyed `${osm_type}/${osm_id}` →
 * `gers_id`), each OSM result is first checked against the link. A hit fuses
 * the OSM result with the Overture entry whose `gersId` matches immediately,
 * marking both as consumed. The union-find spatial+name cascade then runs over
 * the remaining (unconsumed) results.
 *
 * Absent or empty `link` (undefined or `new Map()`) produces output deep-equal
 * to the 3-arg form — the union-find runs over all results unchanged.
 *
 * Matched pairs keep the OSM id, carry gersId from Overture, and merge attributes
 * (OSM wins presence; Overture fills gaps + always supplies brand fields).
 * Overture-only results are appended as gap-fill. OSM-only results pass through.
 */
export function fusePoiResults(
  osm: PoiSearchResult[],
  overture: PoiSearchResult[],
  thresholds: ConflationThresholds,
  link?: Map<string, string>,
): PoiSearchResult[] {
  if (overture.length === 0) return osm;

  const osmById = new Map(osm.map((r) => [r.id, r]));
  const overtureByGers = new Map(
    overture.filter((r) => r.gersId).map((r) => [r.gersId as string, r]),
  );

  const linkFused: PoiSearchResult[] = [];
  const consumedOsmIds = new Set<string>();
  const consumedOvertureIds = new Set<string>();

  if (link && link.size > 0) {
    for (const osmR of osm) {
      const key = osmResultLinkKey(osmR.id);
      if (!key) continue;
      const gersId = link.get(key);
      if (!gersId) continue;
      const overtR = overtureByGers.get(gersId);
      if (!overtR) continue;
      linkFused.push(fuseOsmOverturePair(osmR, overtR));
      consumedOsmIds.add(osmR.id);
      consumedOvertureIds.add(overtR.id);
    }
  }

  const remainingOsm = link && link.size > 0 ? osm.filter((r) => !consumedOsmIds.has(r.id)) : osm;
  const remainingOverture =
    link && link.size > 0 ? overture.filter((r) => !consumedOvertureIds.has(r.id)) : overture;

  if (remainingOverture.length === 0) {
    const remainingOsmOnly = remainingOsm;
    return [...linkFused, ...remainingOsmOnly];
  }

  const osmPts: ConflationPoint[] = remainingOsm.map((r) => ({
    id: r.id,
    name: r.name ?? "",
    lat: r.coordinates[1],
    lng: r.coordinates[0],
    category: r.category,
  }));
  const overturePts: ConflationPoint[] = remainingOverture.map((r) => ({
    id: r.id,
    name: r.name ?? "",
    lat: r.coordinates[1],
    lng: r.coordinates[0],
    category: r.category,
  }));

  const conflateResult = conflate(osmPts, overturePts, thresholds);

  const remainingOvertureById = new Map(remainingOverture.map((r) => [r.id, r]));

  const unionFused: PoiSearchResult[] = conflateResult.matched.flatMap(
    ({ a: osmPt, b: overturePt }) => {
      const osmR = osmById.get(osmPt.id);
      const overtR = remainingOvertureById.get(overturePt.id);
      if (!osmR || !overtR) return [];
      return [fuseOsmOverturePair(osmR, overtR)];
    },
  );

  const osmOnly: PoiSearchResult[] = conflateResult.unmatchedA.flatMap((pt) => {
    const r = osmById.get(pt.id);
    return r ? [r] : [];
  });
  const overtureOnly: PoiSearchResult[] = conflateResult.unmatchedB.flatMap((pt) => {
    const r = remainingOvertureById.get(pt.id);
    return r ? [r] : [];
  });

  return [...linkFused, ...unionFused, ...osmOnly, ...overtureOnly];
}
