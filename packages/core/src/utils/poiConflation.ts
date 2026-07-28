import { haversineMeters, nameSimilarity } from "./geo-server";

export interface ConflationPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category?: string;
  /**
   * `postcode|street|housenumber` address key (see geo-server osmAddressKey /
   * overtureAddressKey). When both sides have one, it's a strong same-location
   * signal: equal keys corroborate a match (name-independent), different keys
   * reject it. Absent → fall back to name matching.
   */
  addressKey?: string;
  /** Wikidata/brand-wikidata id; equal ids within the window short-circuit to a match. */
  wikidata?: string;
  /**
   * Canonicalized phone numbers (digits, country/trunk prefix folded — see
   * geo-server parsePhones). The most specific business-identity signal: when
   * both sides have at least one number, INTERSECTING sets confirm the match and
   * fully DISJOINT sets reject it (different numbers → different businesses, even
   * at the same address or under the same brand). Sets (not a single value) so a
   * stale/secondary number on one side never forces a false split. Empty/absent
   * → fall back to weaker signals.
   */
  phones?: string[];
  /**
   * Website host (no scheme/`www.`, lowercased — see geo-server websiteDomain).
   * A brand/site-level corroboration: an equal domain within the window confirms
   * a match. Weaker than phone (chains share one domain across branches; social /
   * booking platforms host thousands of unrelated businesses — see
   * GENERIC_WEBSITE_HOSTS), so it only confirms, never rejects.
   */
  website?: string;
}

export interface ConflationThresholds {
  alwaysMergeM: number;
  softWindowM: number;
  nameDiceFloor: number;
}

export interface ConflationResult {
  matched: Array<{ a: ConflationPoint; b: ConflationPoint; score: ConflationPairScore }>;
  unmatchedA: ConflationPoint[];
  unmatchedB: ConflationPoint[];
}

export type ConflationMethod =
  | "wikidata"
  | "phone"
  | "address-name"
  | "address-category"
  | "website"
  | "spatial-name"
  | "embedding";

/** Auditable evidence and identity confidence for one accepted candidate edge. */
export interface ConflationPairScore {
  matchConfidence: number;
  method: ConflationMethod;
  distanceM: number;
  nameSimilarity: number;
  categoryCompatible: boolean;
  evidence: string[];
}

export interface ScoredConflationPair {
  a: ConflationPoint;
  b: ConflationPoint;
  score: ConflationPairScore;
}

/** Defaults calibrated against the committed human-reviewed quality corpus. */
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

// Relaxed name floor inside the always-merge band. Proximity is strong
// corroborating evidence, so the floor is lower than the soft-window floor — but
// it is NOT zero: in dense areas two clearly-different businesses sit within a
// few metres (adjacent shops, mall units, stacked POIs), and distance alone must
// never force a merge. A bare-distance auto-merge produced ~75% false links on
// real city-scale data.
const CLOSE_BAND_NAME_FLOOR = 0.5;
// Name floor for confirming a same-address pair when a name signal is available.
const ADDRESS_MATCH_NAME_FLOOR = 0.5;

// Categories where two distinct POIs almost never share one street address. For
// these, a shared address + equal category confirms the match even without a
// name signal. Excluded "plural" categories (restaurants, cafes, bars, gyms, …)
// routinely co-locate (food courts, multi-tenant buildings), so they still need
// a name match — a shared address + "both are restaurants" is NOT enough.
// Non-identifying website hosts: social, link-in-bio, map and food-ordering
// platforms list thousands of unrelated businesses, so a shared one of these is
// NOT evidence of the same business. The website-confirm branch skips them.
const GENERIC_WEBSITE_HOSTS = new Set([
  "facebook.com",
  "m.facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "linktr.ee",
  "linktree.com",
  "google.com",
  "business.google.com",
  "maps.google.com",
  "goo.gl",
  "wa.me",
  "t.me",
  "yelp.com",
  "tripadvisor.com",
  "lieferando.de",
  "wolt.com",
  "ubereats.com",
]);

const SINGULAR_PER_ADDRESS = new Set([
  "supermarkets",
  "pharmacies",
  "banks",
  "atms",
  "fuel",
  "hospitals",
  "post_offices",
  "fire_stations",
  "police",
  "ambulance_stations",
  "libraries",
  "schools",
  "kindergartens",
  "hotels",
  "transit",
  "cinemas",
  "ev_charging",
]);

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Returns an explainable identity score, or null when the pair is rejected. */
export function scoreConflationPair(
  a: ConflationPoint,
  b: ConflationPoint,
  t: ConflationThresholds,
): ConflationPairScore | null {
  const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  if (d > t.softWindowM) return null;
  const names = nameSimilarity(a.name, b.name);
  const categoriesMatch = categoryCompatible(a, b);
  const makeScore = (
    method: ConflationMethod,
    matchConfidence: number,
    evidence: string[],
  ): ConflationPairScore => ({
    method,
    matchConfidence: clampConfidence(matchConfidence),
    distanceM: d,
    nameSimilarity: names,
    categoryCompatible: categoriesMatch,
    evidence,
  });

  // Same specific entity / same brand outlet within the window → same place. An
  // explicit wikidata identity link is honoured over a phone discrepancy (which
  // is often stale or a secondary number).
  if (a.wikidata && b.wikidata && a.wikidata === b.wikidata) {
    return makeScore("wikidata", 1, [`wikidata:${a.wikidata}`, "within-soft-window"]);
  }

  // Phone is the most specific business-identity signal. Sets INTERSECT → same
  // business (confirm); both non-empty yet DISJOINT → different numbers, so
  // different businesses (reject) even when name, address or brand coincide
  // (distinct co-located shops, two branches of one chain in-window). The
  // confirm is category-gated so a shared switchboard — a hotel's reception
  // number listed on its restaurant and bar — does not merge those distinct
  // units; an incompatible category falls through to address/name instead.
  const aPhones = a.phones ?? [];
  const bPhones = b.phones ?? [];
  const phonesBoth = aPhones.length > 0 && bPhones.length > 0;
  const phonesShare = phonesBoth && aPhones.some((p) => bPhones.includes(p));
  if (phonesBoth && !phonesShare) return null;
  if (phonesShare && categoriesMatch) {
    return makeScore("phone", 0.99, ["shared-phone", "compatible-category"]);
  }

  // Address corroboration. A shared address is a strong location signal but does
  // NOT confirm the business: OSM and Overture map different POIs at the same
  // building, so a matching address alone links different businesses. Treat it as
  // necessary-not-sufficient — a CONTRADICTING address rejects even a strong name
  // match; a matching address confirms only with a name signal, or an equal
  // category that is singular-per-address.
  if (a.addressKey && b.addressKey) {
    if (a.addressKey !== b.addressKey) return null;
    if (names >= ADDRESS_MATCH_NAME_FLOOR) {
      return makeScore("address-name", 0.94 + 0.05 * names, ["same-address", "name-corroboration"]);
    }
    const singularCategory =
      a.category !== undefined && a.category === b.category && SINGULAR_PER_ADDRESS.has(a.category)
        ? a.category
        : undefined;
    if (singularCategory) {
      return makeScore("address-category", 0.94, [
        "same-address",
        `singular-category:${singularCategory}`,
      ]);
    }
    return null;
  }

  // Website-host corroboration. Checked AFTER the address gate so a shared host
  // can never override an address contradiction, category-gated, and skipped for
  // non-identifying shared hosts (social/booking/link-in-bio platforms list
  // thousands of unrelated businesses).
  if (
    a.website &&
    b.website &&
    a.website === b.website &&
    !GENERIC_WEBSITE_HOSTS.has(a.website) &&
    categoriesMatch
  ) {
    return makeScore("website", 0.92 + 0.05 * names, [
      `shared-website:${a.website}`,
      "compatible-category",
    ]);
  }

  // Name fallback (no usable address on at least one side).
  const floor = d <= t.alwaysMergeM ? CLOSE_BAND_NAME_FLOOR : t.nameDiceFloor;
  if (names < floor || (d > t.alwaysMergeM && !categoriesMatch)) return null;
  const normalizedName = (names - floor) / Math.max(1 - floor, Number.EPSILON);
  const proximity = 1 - d / t.softWindowM;
  return makeScore("spatial-name", 0.72 + 0.2 * normalizedName + 0.08 * proximity, [
    d <= t.alwaysMergeM ? "close-band" : "soft-window",
    "name-match",
    ...(categoriesMatch ? ["compatible-category"] : []),
  ]);
}

function solveComponent(edges: ScoredConflationPair[]): ScoredConflationPair[] {
  const aIds = [...new Set(edges.map((edge) => edge.a.id))].sort();
  const bIds = [...new Set(edges.map((edge) => edge.b.id))].sort();
  const size = Math.max(aIds.length, bIds.length);
  const edgeByPair = new Map<string, ScoredConflationPair>();
  for (const edge of edges) {
    const key = `${edge.a.id}\u0000${edge.b.id}`;
    const existing = edgeByPair.get(key);
    if (!existing || edge.score.matchConfidence > existing.score.matchConfidence) {
      edgeByPair.set(key, edge);
    }
  }

  // Hungarian assignment over this connected candidate component. Every real
  // edge gets a cardinality bonus of 1, so the optimum first maximizes the
  // number of accepted links and then their total identity confidence.
  const weights = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (let i = 0; i < aIds.length; i++) {
    for (let j = 0; j < bIds.length; j++) {
      const edge = edgeByPair.get(`${aIds[i]}\u0000${bIds[j]}`);
      if (edge) weights[i][j] = 1 + edge.score.matchConfidence;
    }
  }

  const maxWeight = 2;
  const u = new Array<number>(size + 1).fill(0);
  const v = new Array<number>(size + 1).fill(0);
  const p = new Array<number>(size + 1).fill(0);
  const way = new Array<number>(size + 1).fill(0);
  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(size + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= size; j++) {
        if (used[j]) continue;
        const cost = maxWeight - weights[i0 - 1][j - 1];
        const current = cost - u[i0] - v[j];
        if (current < minv[j]) {
          minv[j] = current;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= size; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const selected: ScoredConflationPair[] = [];
  for (let j = 1; j <= size; j++) {
    const i = p[j] - 1;
    if (i < 0 || i >= aIds.length || j - 1 >= bIds.length) continue;
    const edge = edgeByPair.get(`${aIds[i]}\u0000${bIds[j - 1]}`);
    if (edge) selected.push(edge);
  }
  return selected;
}

/** Deterministic maximum-cardinality, maximum-confidence global assignment. */
export function assignConflationPairs(
  candidateEdges: readonly ScoredConflationPair[],
): ScoredConflationPair[] {
  if (candidateEdges.length === 0) return [];
  const edges = [...candidateEdges].sort(
    (left, right) =>
      left.a.id.localeCompare(right.a.id) ||
      left.b.id.localeCompare(right.b.id) ||
      right.score.matchConfidence - left.score.matchConfidence,
  );
  const edgesByNode = new Map<string, ScoredConflationPair[]>();
  for (const edge of edges) {
    for (const key of [`a:${edge.a.id}`, `b:${edge.b.id}`]) {
      const bucket = edgesByNode.get(key);
      if (bucket) bucket.push(edge);
      else edgesByNode.set(key, [edge]);
    }
  }

  const visited = new Set<string>();
  const selected: ScoredConflationPair[] = [];
  for (const start of [...edgesByNode.keys()].sort()) {
    if (visited.has(start)) continue;
    const stack = [start];
    const componentEdges = new Set<ScoredConflationPair>();
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);
      for (const edge of edgesByNode.get(node) ?? []) {
        componentEdges.add(edge);
        const aKey = `a:${edge.a.id}`;
        const bKey = `b:${edge.b.id}`;
        if (!visited.has(aKey)) stack.push(aKey);
        if (!visited.has(bKey)) stack.push(bKey);
      }
    }
    selected.push(...solveComponent([...componentEdges]));
  }
  return selected.sort(
    (left, right) => left.a.id.localeCompare(right.a.id) || left.b.id.localeCompare(right.b.id),
  );
}

/**
 * Bipartite conflation of two POI sets: a (e.g. OSM) vs b (e.g. Overture).
 *
 * Generates every accepted cross-set edge, then performs deterministic global
 * one-to-one assignment across each connected candidate component.
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

  // Build spatial buckets for b-side points
  const bBuckets = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const key = bucketKey(b[j].lat, b[j].lng);
    const arr = bBuckets.get(key);
    if (arr) arr.push(j);
    else bBuckets.set(key, [j]);
  }

  const candidateEdges: ScoredConflationPair[] = [];
  for (let i = 0; i < a.length; i++) {
    const selfKey = bucketKey(a[i].lat, a[i].lng);
    for (const nKey of neighborKeys(selfKey, a[i].lat, t.softWindowM)) {
      const candidates = bBuckets.get(nKey);
      if (!candidates) continue;
      for (const jRel of candidates) {
        const score = scoreConflationPair(a[i], b[jRel], t);
        if (score) candidateEdges.push({ a: a[i], b: b[jRel], score });
      }
    }
  }
  const matched = assignConflationPairs(candidateEdges);
  const matchedA = new Set(matched.map((pair) => pair.a.id));
  const matchedB = new Set(matched.map((pair) => pair.b.id));
  const unmatchedA = a.filter((point) => !matchedA.has(point.id));
  const unmatchedB = b.filter((point) => !matchedB.has(point.id));

  return { matched, unmatchedA, unmatchedB };
}
