import { createHash } from "node:crypto";
import type { AmbientBuildProgress, AmbientManifest } from "@openmapx/core/ambient-places";
import type postgres from "postgres";
import { fresh } from "./publication.js";

export interface PlanetCheckpoint extends AmbientBuildProgress {
  osmType: string;
  osmId: string;
  gers: string;
  osmProcessed: number;
  overtureProcessed: number;
  osmCount: number;
  overtureCount: number;
}
export interface PlanetStage {
  generation: string;
  status: "running" | "failed" | "completed";
  checkpoint: PlanetCheckpoint;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}
export interface PlanetSources {
  signature: string;
  osmRows: number;
  overtureRows: number;
  sources: AmbientManifest["sources"];
}
function count(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid planet source row count");
  return n;
}
/** Locks held by the caller freeze these published tables between batches. */
export async function capturePlanetSources(sql: postgres.Sql): Promise<PlanetSources> {
  const [exists] = await sql.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('osm_search.index_state') IS NOT NULL AS exists`,
  );
  if (!exists.exists) throw new Error("Prepare the planet OSM search snapshot first");
  const [osm] = await sql.unsafe<{ state: Record<string, unknown>; oid: number }[]>(
    `SELECT to_jsonb(s) AS state,'osm_search.places'::regclass::OID AS oid FROM osm_search.index_state s WHERE singleton=1`,
  );
  if (!osm || osm.state.region !== "planet" || osm.state.status !== "ready")
    throw new Error("A ready planet OSM snapshot is required");
  if (osm.state.ambient_source_version !== 2 || typeof osm.state.source_file_identity !== "string")
    throw new Error("Rebuild the planet OSM snapshot with ambient source format 2");
  if (osm.state.current_fingerprint !== osm.state.source_fingerprint)
    throw new Error("Planet OSM source changed; rebuild the source snapshot");
  const osmPublished = fresh(osm.state.published_at as string | null);
  const sources: AmbientManifest["sources"] = {
    osm: { region: "planet", epoch: String(osm.state.epoch), publishedAt: osmPublished, count: 0 },
    overture: null,
  };
  const pin: Record<string, unknown> = {
    osm: {
      oid: osm.oid,
      epoch: osm.state.epoch,
      publication: osmPublished,
      fingerprint: osm.state.source_fingerprint,
      file: osm.state.source_file_identity,
      format: 2,
    },
  };
  const osmRows = count(osm.state.place_count);
  if (!osmRows) throw new Error("Planet OSM snapshot is empty");
  let overtureRows = 0;
  const [otExists] = await sql.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('overture_places.places') IS NOT NULL AS exists`,
  );
  if (otExists.exists) {
    const [conflation] = await sql.unsafe<{ exists: boolean }[]>(
      `SELECT to_regclass('overture_places.conflation_state') IS NOT NULL AS exists`,
    );
    if (!conflation.exists) throw new Error("Planet Overture conflation state is missing");
    const [ot] = await sql.unsafe<
      { state: Record<string, unknown>; oid: number; links: number; osm: number }[]
    >(
      `SELECT to_jsonb(s) AS state,'overture_places.places'::regclass::OID AS oid,'overture_places.poi_conflation_link'::regclass::OID AS links,'overture_places.osm_pois'::regclass::OID AS osm FROM overture_places.conflation_state s WHERE singleton=1`,
    );
    if (!ot) {
      const [row] = await sql.unsafe<{ populated: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM overture_places.places LIMIT 1) AS populated`,
      );
      if (row.populated) throw new Error("Planet Overture conflation state is missing");
    } else {
      if (ot.state.region !== "planet" || ot.state.status !== "completed")
        throw new Error("Complete planet Overture conflation before ambient publication");
      if (ot.state.source_fingerprint !== osm.state.source_file_identity)
        throw new Error(
          "Planet OSM and Overture links use different OSM snapshots; rebuild matching sources",
        );
      const publishedAt = fresh(ot.state.places_published_at as string | null);
      const completedAt = fresh(ot.state.completed_at as string | null);
      overtureRows = count(ot.state.place_count);
      sources.overture = {
        region: "planet",
        release: String(ot.state.release),
        publishedAt,
        count: 0,
      };
      pin.overture = {
        oid: ot.oid,
        links: ot.links,
        osm: ot.osm,
        release: ot.state.release,
        publication: publishedAt,
        completion: completedAt,
        attempt: ot.state.attempt_count,
        fingerprint: ot.state.source_fingerprint,
      };
    }
  }
  pin.osmRows = osmRows;
  pin.overtureRows = overtureRows;
  return {
    signature: createHash("sha256").update(JSON.stringify(pin)).digest("hex"),
    osmRows,
    overtureRows,
    sources,
  };
}
export async function readPlanetStage(sql: postgres.Sql): Promise<PlanetStage | null> {
  const [exists] = await sql.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('ambient_places.planet_builds') IS NOT NULL AS exists`,
  );
  if (!exists.exists) return null;
  const [row] = await sql.unsafe<PlanetStage[]>(
    `SELECT b.generation,b.status,b.checkpoint,b.error,b.started_at::TEXT AS "startedAt",b.updated_at::TEXT AS "updatedAt" FROM ambient_places.planet_builds b JOIN ambient_places.generations g ON g.id=b.generation WHERE g.publication_status='staging' ORDER BY b.started_at DESC LIMIT 1`,
  );
  return row ?? null;
}
