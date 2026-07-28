import type { PoiSearchResult } from "../types/category";
import { parsePhones, websiteDomain } from "./geo-server";
import { type ConflationPoint, type ConflationThresholds, conflate } from "./poiConflation";

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
    email: osmR.email ?? overtR.email,
    website: osmR.website ?? overtR.website,
    socials: osmR.socials ?? overtR.socials,
    address: osmR.address ?? overtR.address,
    brand: osmR.brand ?? overtR.brand,
    names: osmR.names ?? overtR.names,
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

  // Carry phone/website so the query-time residual conflation uses the same
  // corroboration signals as the precomputed batch link table; otherwise the two
  // paths would disagree on a pair depending on whether the link table covered it.
  const osmPts: ConflationPoint[] = remainingOsm.map((r) => ({
    id: r.id,
    name: r.name ?? "",
    lat: r.coordinates[1],
    lng: r.coordinates[0],
    category: r.category,
    phones: parsePhones(r.phone),
    website: websiteDomain(r.website) ?? undefined,
  }));
  const overturePts: ConflationPoint[] = remainingOverture.map((r) => ({
    id: r.id,
    name: r.name ?? "",
    lat: r.coordinates[1],
    lng: r.coordinates[0],
    category: r.category,
    phones: parsePhones(r.phone),
    website: websiteDomain(r.website) ?? undefined,
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
