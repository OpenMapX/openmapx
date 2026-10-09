import { assertSupportedOvertureContributors, type OvertureSourceItem } from "@openmapx/core";
import {
  AMBIENT_LIMITS,
  type AmbientOsmRow,
  type AmbientOvertureRow,
  type AmbientPlace,
  ambientPlaceFromOsm,
  ambientPlaceFromOverture,
  mergeAmbientPlaces,
} from "@openmapx/core/ambient-places";
import type postgres from "postgres";
import type { PlanetCheckpoint } from "./planet-state.js";

type OvertureInput = AmbientOvertureRow & { sources: OvertureSourceItem[] | null; release: string };
function eligible(row: OvertureInput, release: string): AmbientPlace | null {
  if (row.release !== release)
    throw new Error("Planet Overture release does not match source contract");
  const p = ambientPlaceFromOverture(row);
  if (p)
    assertSupportedOvertureContributors(
      (row.sources ?? []).flatMap((s) => (s.dataset ? [s.dataset] : [])),
    );
  return p;
}
export async function planetOsmBatch(
  tx: postgres.TransactionSql,
  checkpoint: PlanetCheckpoint,
  release: string | null,
): Promise<{ places: AmbientPlace[]; checkpoint: PlanetCheckpoint; rows: number }> {
  const rows = await tx.unsafe<AmbientOsmRow[]>(
    `SELECT osm_type,osm_id::TEXT,name,lng,lat,category,tags,importance FROM osm_search.places WHERE (osm_type,osm_id)>($1,$2::BIGINT) ORDER BY osm_type,osm_search.places.osm_id LIMIT ${AMBIENT_LIMITS.countryBatch}`,
    [checkpoint.osmType, checkpoint.osmId],
  );
  if (!rows.length)
    return {
      places: [],
      checkpoint: { ...checkpoint, phase: release ? "overture" : "validate" },
      rows: 0,
    };
  const osm = rows.flatMap((r) => {
    const p = ambientPlaceFromOsm(r);
    return p ? [p] : [];
  });
  let overture: AmbientPlace[] = [];
  const links = new Map<string, string>();
  if (release) {
    const linked = await tx.unsafe<(OvertureInput & { osm_type: string; osm_id: string })[]>(
      `SELECT o.gers_id,o.name,ST_X(o.geom) AS longitude,ST_Y(o.geom) AS latitude,o.basic_category,o.taxonomy_primary,o.taxonomy_hierarchy,o.taxonomy_alternates,o.names,o.confidence,o.operating_status,o.sources,o.release,l.osm_type,l.osm_id::TEXT
    FROM jsonb_to_recordset($1::TEXT::JSONB) AS r(osm_type TEXT,osm_id TEXT)
    JOIN overture_places.poi_conflation_link l ON l.osm_type=r.osm_type AND l.osm_id=r.osm_id::BIGINT AND l.release=$2
    JOIN overture_places.places o USING(gers_id)`,
      [JSON.stringify(rows.map((r) => ({ osm_type: r.osm_type, osm_id: r.osm_id }))), release],
    );
    overture = linked.flatMap((r) => {
      // Accepted identity survives even when Overture display fields are excluded.
      links.set(`osm:${r.osm_type}/${r.osm_id}`, r.gers_id);
      const p = eligible(r, release);
      if (!p) return [];
      return [p];
    });
  }
  const eligibleIds = new Set(osm.map((p) => p.id));
  const excluded = new Set(
    rows.map((r) => `osm:${r.osm_type}/${r.osm_id}`).filter((id) => !eligibleIds.has(id)),
  );
  const places = mergeAmbientPlaces(osm, overture, links, excluded);
  const last = rows[rows.length - 1];
  return {
    places,
    rows: rows.length,
    checkpoint: {
      ...checkpoint,
      osmType: last.osm_type,
      osmId: last.osm_id,
      osmCount: checkpoint.osmCount + osm.length,
      osmProcessed: checkpoint.osmProcessed + rows.length,
    },
  };
}
export async function planetOvertureBatch(
  tx: postgres.TransactionSql,
  checkpoint: PlanetCheckpoint,
  release: string,
): Promise<{ places: AmbientPlace[]; checkpoint: PlanetCheckpoint; rows: number }> {
  const rows = await tx.unsafe<
    (OvertureInput & {
      osm_type: string | null;
      osm_id: string | null;
      indexed_osm_id: string | null;
      linked_osm: AmbientOsmRow | null;
    })[]
  >(
    `SELECT o.gers_id,o.name,ST_X(o.geom) AS longitude,ST_Y(o.geom) AS latitude,o.basic_category,o.taxonomy_primary,o.taxonomy_hierarchy,o.taxonomy_alternates,o.names,o.confidence,o.operating_status,o.sources,o.release,l.osm_type,l.osm_id::TEXT,p.osm_id::TEXT AS indexed_osm_id,
   CASE WHEN raw.osm_id IS NULL THEN NULL ELSE jsonb_build_object('osm_type',raw.osm_type,'osm_id',raw.osm_id::TEXT,'name',raw.name,'lng',raw.lng,'lat',raw.lat,'category',raw.category,'tags',coalesce(raw.tags,'{}'::JSONB),'importance',0.5) END AS linked_osm
   FROM (SELECT * FROM overture_places.places WHERE gers_id>$1 ORDER BY gers_id LIMIT ${AMBIENT_LIMITS.countryBatch}) o
   LEFT JOIN overture_places.poi_conflation_link l ON l.gers_id=o.gers_id AND l.release=$2
   LEFT JOIN osm_search.places p ON p.osm_type=l.osm_type AND p.osm_id=l.osm_id
   LEFT JOIN overture_places.osm_pois raw ON raw.osm_type=l.osm_type AND raw.osm_id=l.osm_id
   ORDER BY o.gers_id`,
    [checkpoint.gers, release],
  );
  if (!rows.length)
    return { places: [], checkpoint: { ...checkpoint, phase: "validate" }, rows: 0 };
  let count = 0;
  const places = rows.flatMap((r) => {
    const p = eligible(r, release);
    if (!p) return [];
    count++;
    // Indexed OSM owns policy and location, including excluded/closed/polar rows.
    if (r.indexed_osm_id !== null) return [];
    if (r.linked_osm) {
      const authoritative = ambientPlaceFromOsm({
        ...r.linked_osm,
        name: r.linked_osm.name || r.name,
      });
      return authoritative
        ? mergeAmbientPlaces(
            [authoritative],
            [p],
            new Map([[authoritative.id, p.gersId ?? r.gers_id]]),
          )
        : [];
    }
    return [{ ...p, ...(r.osm_id !== null ? { id: `osm:${r.osm_type}/${r.osm_id}` } : {}) }];
  });
  return {
    places,
    rows: rows.length,
    checkpoint: {
      ...checkpoint,
      gers: rows[rows.length - 1].gers_id,
      overtureCount: checkpoint.overtureCount + count,
      overtureProcessed: checkpoint.overtureProcessed + rows.length,
    },
  };
}
