import { assertSupportedOvertureContributors, type OvertureSourceItem } from "@openmapx/core";
import {
  AMBIENT_LIMITS,
  AMBIENT_POLICY_VERSION,
  type AmbientBuildProgress,
  type AmbientManifest,
  type AmbientOsmRow,
  type AmbientOvertureRow,
  type AmbientPlace,
  type AmbientRegion,
  ambientPlaceFromOsm,
  ambientPlaceFromOverture,
  mergeAmbientPlaces,
} from "@openmapx/core/ambient-places";
import type postgres from "postgres";
import { freeBytesInPostgresContainer } from "../overture/capacity.js";
import { assertAmbientDiskCapacity } from "./capacity.js";
import {
  activateAmbientGeneration,
  fresh,
  insertAmbientFeatures,
  prepareAmbientGeneration,
  tableExists,
} from "./publication.js";

export interface AmbientBuildOptions {
  availableBytes?: () => Promise<number>;
  onProgress?: (progress: AmbientBuildProgress) => void | Promise<void>;
}
interface OsmState {
  region: string;
  epoch: string;
  published_at: Date | null;
  place_count: string;
}
type OvertureRow = AmbientOvertureRow & { sources: OvertureSourceItem[] | null; release: string };
const OVERTURE_COLUMNS = `o.gers_id,o.name,ST_X(o.geom) AS longitude,ST_Y(o.geom) AS latitude,o.basic_category,o.taxonomy_primary,o.taxonomy_hierarchy,o.taxonomy_alternates,o.names,o.confidence,o.operating_status,o.sources,o.release`;
function eligibleOverture(row: OvertureRow): AmbientPlace | null {
  const place = ambientPlaceFromOverture(row);
  if (place)
    assertSupportedOvertureContributors(
      (row.sources ?? []).flatMap((s) => (s.dataset ? [s.dataset] : [])),
    );
  return place;
}

/** Called under the publisher's repeatable-read transaction and writer lock. */
export async function buildGermanyPlaces(
  tx: postgres.TransactionSql,
  region: AmbientRegion,
  osmState: OsmState,
  options: AmbientBuildOptions,
): Promise<AmbientManifest> {
  if (osmState.region !== "europe/germany")
    throw new Error("Germany coverage requires the complete europe/germany OSM search snapshot");
  const generation = await prepareAmbientGeneration(tx);
  const manifest: AmbientManifest = {
    version: 1,
    policyVersion: AMBIENT_POLICY_VERSION,
    generation,
    publishedAt: new Date().toISOString(),
    region,
    placeCount: 0,
    enabled: true,
    sources: {
      osm: {
        region: osmState.region,
        epoch: osmState.epoch,
        publishedAt: fresh(osmState.published_at),
        count: 0,
      },
      overture: null,
    },
  };
  let inputCount = Number(osmState.place_count);
  if (await tableExists(tx, "overture_places.places")) {
    if (!(await tableExists(tx, "overture_places.conflation_state")))
      throw new Error("Overture conflation state is missing");
    const [state] = await tx.unsafe<
      {
        region: string;
        release: string;
        status: string;
        places_published_at: Date | null;
        place_count: string;
      }[]
    >(
      `SELECT region,release,status,places_published_at,place_count::TEXT FROM overture_places.conflation_state WHERE singleton=1`,
    );
    if (!state) {
      const [input] = await tx.unsafe<{ populated: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM overture_places.places LIMIT 1) AS populated`,
      );
      if (input.populated) throw new Error("Overture conflation state is missing");
    } else {
      if (state.region !== "europe/germany")
        throw new Error("Germany coverage requires the complete europe/germany Overture snapshot");
      if (state.status !== "completed")
        throw new Error("Overture conflation must be completed before ambient publication");
      const [releases] = await tx.unsafe<{ mismatch: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM overture_places.places WHERE release<>$1 LIMIT 1) AS mismatch`,
        [state.release],
      );
      if (releases.mismatch)
        throw new Error("Overture conflation release does not match published places");
      manifest.sources.overture = {
        region: state.region,
        release: state.release,
        publishedAt: fresh(state.places_published_at),
        count: 0,
      };
      inputCount += Number(state.place_count);
    }
  }
  const available = options.availableBytes ?? freeBytesInPostgresContainer;
  assertAmbientDiskCapacity(await available(), inputCount);
  await tx.unsafe(
    `INSERT INTO ambient_places.generations(id,manifest) VALUES($1,$2::TEXT::JSONB)`,
    [generation, JSON.stringify(manifest)],
  );
  const [west, south, east, north] = region.bounds;
  const inside = (p: AmbientPlace) =>
    p.coordinates[0] >= west &&
    p.coordinates[0] <= east &&
    p.coordinates[1] >= south &&
    p.coordinates[1] <= north;
  let processed = 0;
  let batches = 0;
  const insert = async (
    places: AmbientPlace[],
    phase: AmbientBuildProgress["phase"],
    inputRows: number,
  ) => {
    manifest.placeCount += places.length;
    if (manifest.placeCount > AMBIENT_LIMITS.countryPlaces)
      throw new Error("Germany output exceeds 20000000 places");
    await insertAmbientFeatures(tx, generation, places);
    processed += inputRows;
    batches++;
    if (batches % 25 === 0) assertAmbientDiskCapacity(await available());
    await options.onProgress?.({ phase, processed, batches, placeCount: manifest.placeCount });
  };
  let osmType = "";
  let osmId = "0";
  for (;;) {
    const rows = await tx.unsafe<AmbientOsmRow[]>(
      `SELECT osm_type,osm_id::TEXT,name,lng,lat,category,tags,importance FROM osm_search.places WHERE (osm_type,osm_id)>($1,$2::BIGINT) ORDER BY osm_type,osm_search.places.osm_id LIMIT ${AMBIENT_LIMITS.countryBatch}`,
      [osmType, osmId],
    );
    if (!rows.length) break;
    const osm = rows.flatMap((row) => {
      const p = ambientPlaceFromOsm(row);
      return p && inside(p) ? [p] : [];
    });
    const links = new Map<string, string>();
    let overture: AmbientPlace[] = [];
    if (manifest.sources.overture && osm.length) {
      const eligibleIds = new Set(osm.map((p) => p.id));
      const linked = await tx.unsafe<(OvertureRow & { osm_type: string; osm_id: string })[]>(
        `SELECT l.osm_type,l.osm_id::TEXT,${OVERTURE_COLUMNS}
        FROM jsonb_to_recordset($1::TEXT::JSONB) AS r(osm_type TEXT,osm_id BIGINT)
        JOIN overture_places.poi_conflation_link l USING(osm_type,osm_id) JOIN overture_places.places o USING(gers_id)
        WHERE l.release=$2`,
        [
          JSON.stringify(
            rows
              .filter((r) => eligibleIds.has(`osm:${r.osm_type}/${r.osm_id}`))
              .map((r) => ({ osm_type: r.osm_type, osm_id: r.osm_id })),
          ),
          manifest.sources.overture.release,
        ],
      );
      overture = linked.flatMap((row) => {
        links.set(`osm:${row.osm_type}/${row.osm_id}`, row.gers_id);
        const p = eligibleOverture(row);
        return p ? [p] : [];
      });
    }
    manifest.sources.osm.count += osm.length;
    await insert(mergeAmbientPlaces(osm, overture, links).filter(inside), "osm", rows.length);
    const last = rows[rows.length - 1];
    osmType = last.osm_type;
    osmId = last.osm_id;
  }
  if (manifest.sources.overture) {
    let cursor = "";
    for (;;) {
      const rows = await tx.unsafe<
        (OvertureRow & {
          osm_type: string | null;
          osm_id: string | null;
          indexed_osm_id: string | null;
        })[]
      >(
        `SELECT ${OVERTURE_COLUMNS},l.osm_type,l.osm_id::TEXT,p.osm_id::TEXT AS indexed_osm_id
        FROM (SELECT * FROM overture_places.places WHERE gers_id>$1 ORDER BY gers_id LIMIT ${AMBIENT_LIMITS.countryBatch}) o
        LEFT JOIN overture_places.poi_conflation_link l ON l.gers_id=o.gers_id AND l.release=$2
        LEFT JOIN osm_search.places p ON p.osm_type=l.osm_type AND p.osm_id=l.osm_id ORDER BY o.gers_id`,
        [cursor, manifest.sources.overture.release],
      );
      if (!rows.length) break;
      const places = rows.flatMap((row) => {
        const p = ambientPlaceFromOverture(row);
        if (!p || !inside(p)) return [];
        eligibleOverture(row);
        manifest.sources.overture!.count++;
        // Existing OSM rows own policy and position, even if excluded/outside.
        if (row.indexed_osm_id !== null) return [];
        return [
          { ...p, ...(row.osm_id !== null ? { id: `osm:${row.osm_type}/${row.osm_id}` } : {}) },
        ];
      });
      await insert(places, "overture", rows.length);
      cursor = rows[rows.length - 1].gers_id;
    }
  }
  if (!manifest.placeCount) throw new Error("Refusing to publish an empty ambient generation");
  assertAmbientDiskCapacity(await available());
  manifest.publishedAt = new Date().toISOString();
  await options.onProgress?.({
    phase: "validate",
    processed,
    batches,
    placeCount: manifest.placeCount,
  });
  await activateAmbientGeneration(tx, manifest);
  return manifest;
}
