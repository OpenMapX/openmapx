import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildNotablePlacesFinishDDL,
  buildNotablePlacesSchemaDDL,
} from "../../src/jobs/notable-places/schema.js";
import { NOTABLE_DISPLAY_LANGUAGES } from "../../src/jobs/notable-places/sparql.js";
import {
  buildEmbeddingCacheDDL,
  buildOsmPoisIndexesDDL,
  buildOsmPoisTableDDL,
  buildSchemaDDL,
} from "../../src/jobs/overture/schema.js";
import { buildPublicationFenceDDL } from "../../src/jobs/publication-fence.js";
import { publishSchemaSwap, publishTableSwap } from "../../src/jobs/publish-schema-swap.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";
import { type PostgisFixture, startPostgis } from "../helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";
const quickRetry = { attempts: 2, backoffMs: 10 };
const SUFFIX = { index: "idx", p: "pkey", u: "key", f: "fkey", c: "check" } as const;

describe.skipIf(skipE2e)("data-manager runtime schemas in PostGIS", () => {
  let pg: PostgisFixture;
  let reader: postgres.Sql;

  beforeAll(async () => {
    pg = await startPostgis();
    reader = postgres(pg.connectionString, { max: 1 });
  }, 120_000);

  afterAll(async () => {
    await reader?.end({ timeout: 2 });
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.sql.unsafe(
      `DROP SCHEMA IF EXISTS osm_search,osm_search__staging,osm_search__previous,notable_places,notable_places__staging,overture_places,overture_embeddings CASCADE`,
    );
  });

  it("creates constrained search-index tables and usable term/proximity indexes", async () => {
    await pg.sql.unsafe(buildSearchIndexSchemaDDL("osm_search__staging"));
    await pg.sql.unsafe(
      `INSERT INTO osm_search__staging.places
        (osm_type, osm_id, name, geom, category, tags, importance)
       VALUES ('node', 1, 'Example', ST_Point(13.4, 52.5, 4326), 'place:city', '{}', 0.9)`,
    );
    await pg.sql.unsafe(
      `INSERT INTO osm_search__staging.terms
        (osm_type, osm_id, normalized_term, display_value, kind, namespace)
       VALUES ('node', 1, 'ex', 'EX', 'explicit_alias', 'short_name')`,
    );
    await pg.sql.unsafe(buildSearchIndexIndexesDDL("osm_search__staging"));
    const indexes = await pg.sql.unsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='osm_search__staging'`,
    );
    expect(indexes.map((row) => row.indexname).sort()).toEqual([
      "index_state_pkey",
      "places_geom_idx",
      "places_pkey",
      "publication_fence_pkey",
      "terms_normalized_term_idx",
      "terms_pkey",
    ]);
    // The provider's exact-or-prefix predicate uses the one pattern index.
    await pg.sql.unsafe(`ANALYZE osm_search__staging.terms`);
    const plan = await pg.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL enable_seqscan = off`);
      return tx.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT * FROM osm_search__staging.terms
          WHERE normalized_term = 'ex' OR normalized_term LIKE 'ex' || '%'`,
      );
    });
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("terms_normalized_term_idx");
  });

  it("names every runtime-built index and constraint <table>_<cols>_<kind>", async () => {
    await pg.sql.unsafe(
      buildSearchIndexSchemaDDL("osm_search__staging") +
        buildSearchIndexIndexesDDL("osm_search__staging") +
        buildNotablePlacesSchemaDDL("notable_places__staging") +
        buildNotablePlacesFinishDDL("notable_places__staging", NOTABLE_DISPLAY_LANGUAGES) +
        buildSchemaDDL("overture_places") +
        buildOsmPoisTableDDL("overture_places", "osm_pois__staging") +
        buildOsmPoisIndexesDDL("overture_places", "osm_pois__staging") +
        buildEmbeddingCacheDDL(),
    );
    const objects = await pg.sql.unsafe<
      { schema: string; table: string; name: string; kind: keyof typeof SUFFIX }[]
    >(
      `SELECT n.nspname AS schema, t.relname AS table, i.relname AS name, 'index' AS kind
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = ANY($1::TEXT[])
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
       UNION ALL
       SELECT n.nspname, t.relname, c.conname, c.contype::TEXT
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = ANY($1::TEXT[]) AND c.contype <> 'n'
        ORDER BY 1, 2, 3`,
      [
        [
          "osm_search__staging",
          "notable_places__staging",
          "overture_embeddings",
          "overture_places",
        ],
      ],
    );
    const misnamed = objects.filter(
      ({ table, name, kind }) =>
        !new RegExp(`^${table}_(?:[a-z0-9_]+_)?${SUFFIX[kind]}$`).test(name) ||
        (kind !== "p" && name === `${table}_${SUFFIX[kind]}`),
    );
    expect(misnamed).toEqual([]);
    expect(objects.map(({ schema, name }) => `${schema}.${name}`)).toEqual([
      "notable_places__staging.descriptions_pkey",
      "notable_places__staging.descriptions_qid_fkey",
      "notable_places__staging.index_state_pkey",
      "notable_places__staging.index_state_singleton_check",
      "notable_places__staging.index_state_status_check",
      "notable_places__staging.labels_pkey",
      "notable_places__staging.labels_qid_fkey",
      "notable_places__staging.names_normalized_idx",
      "notable_places__staging.names_normalized_trgm_idx",
      "notable_places__staging.names_pkey",
      "notable_places__staging.names_qid_fkey",
      "notable_places__staging.places_fame_check",
      "notable_places__staging.places_geom_check",
      "notable_places__staging.places_geom_idx",
      "notable_places__staging.places_kind_check",
      "notable_places__staging.places_pkey",
      "notable_places__staging.places_qid_check",
      "notable_places__staging.places_sitelinks_check",
      "notable_places__staging.publication_fence_pkey",
      "notable_places__staging.publication_fence_singleton_check",
      "osm_search__staging.index_state_pkey",
      "osm_search__staging.index_state_singleton_check",
      "osm_search__staging.index_state_status_check",
      "osm_search__staging.places_geom_check",
      "osm_search__staging.places_geom_idx",
      "osm_search__staging.places_importance_check",
      "osm_search__staging.places_osm_type_check",
      "osm_search__staging.places_pkey",
      "osm_search__staging.publication_fence_pkey",
      "osm_search__staging.publication_fence_singleton_check",
      "osm_search__staging.terms_kind_check",
      "osm_search__staging.terms_normalized_term_idx",
      "osm_search__staging.terms_osm_type_osm_id_fkey",
      "osm_search__staging.terms_pkey",
      "overture_embeddings.embedding_cache_pkey",
      "overture_places.conflation_state_attempt_count_check",
      "overture_places.conflation_state_phase_check",
      "overture_places.conflation_state_pkey",
      "overture_places.conflation_state_place_count_check",
      "overture_places.conflation_state_singleton_check",
      "overture_places.conflation_state_sources_catalogue_check",
      "overture_places.conflation_state_status_check",
      "overture_places.osm_pois_category_idx",
      "overture_places.osm_pois_geom_check",
      "overture_places.osm_pois_geom_idx",
      "overture_places.osm_pois_h3_r8_osm_type_osm_id_idx",
      "overture_places.osm_pois_pkey",
      "overture_places.osm_pois__staging_category_idx",
      "overture_places.osm_pois__staging_geom_check",
      "overture_places.osm_pois__staging_geom_idx",
      "overture_places.osm_pois__staging_h3_r8_osm_type_osm_id_idx",
      "overture_places.osm_pois__staging_pkey",
      "overture_places.places_basic_category_idx",
      "overture_places.places_geom_idx",
      "overture_places.places_h3_r8_idx",
      "overture_places.places_pkey",
      "overture_places.places_taxonomy_alternates_idx",
      "overture_places.places_taxonomy_hierarchy_idx",
      "overture_places.places_taxonomy_primary_idx",
      "overture_places.poi_conflation_candidate_distance_m_check",
      "overture_places.poi_conflation_candidate_gers_id_fkey",
      "overture_places.poi_conflation_candidate_gers_id_idx",
      "overture_places.poi_conflation_candidate_match_confidence_check",
      "overture_places.poi_conflation_candidate_pkey",
      "overture_places.poi_conflation_component_component_id_osm_type_osm_id_idx",
      "overture_places.poi_conflation_component_pkey",
      "overture_places.poi_conflation_link_distance_m_check",
      "overture_places.poi_conflation_link_gers_id_key",
      "overture_places.poi_conflation_link_match_confidence_check",
      "overture_places.poi_conflation_link_pkey",
      "overture_places.poi_conflation_link_next_distance_m_check",
      "overture_places.poi_conflation_link_next_gers_id_key",
      "overture_places.poi_conflation_link_next_match_confidence_check",
      "overture_places.poi_conflation_link_next_pkey",
      "overture_places.publication_fence_pkey",
      "overture_places.publication_fence_singleton_check",
    ]);
  });

  it("stores runtime points as indexed geometry(Point, 4326) without coordinate columns", async () => {
    await pg.sql.unsafe(
      buildSearchIndexSchemaDDL("osm_search") +
        buildSearchIndexIndexesDDL("osm_search") +
        buildNotablePlacesSchemaDDL("notable_places") +
        buildNotablePlacesFinishDDL("notable_places", NOTABLE_DISPLAY_LANGUAGES) +
        buildSchemaDDL("overture_places"),
    );
    const points = await pg.sql.unsafe(
      `SELECT f_table_schema AS schema, f_table_name AS table, f_geometry_column AS column,
              type, srid
         FROM geometry_columns
        WHERE f_table_schema IN ('osm_search', 'notable_places', 'overture_places')
        ORDER BY 1, 2`,
    );
    expect(points).toEqual([
      { schema: "notable_places", table: "places", column: "geom", type: "POINT", srid: 4326 },
      { schema: "osm_search", table: "places", column: "geom", type: "POINT", srid: 4326 },
      {
        schema: "overture_places",
        table: "osm_pois",
        column: "geom",
        type: "POINT",
        srid: 4326,
      },
      { schema: "overture_places", table: "places", column: "geom", type: "POINT", srid: 4326 },
    ]);
    const leftovers = await pg.sql.unsafe(
      `SELECT table_schema, table_name, column_name FROM information_schema.columns
        WHERE table_schema IN ('osm_search', 'notable_places', 'overture_places')
          AND (column_name IN ('lat', 'lng') OR udt_name = 'geography')`,
    );
    expect(leftovers).toEqual([]);
    const gist = await pg.sql.unsafe<{ index: string }[]>(
      `SELECT n.nspname || '.' || i.relname AS index
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_am am ON am.oid = i.relam
        WHERE am.amname = 'gist' AND n.nspname IN ('osm_search', 'notable_places', 'overture_places')
        ORDER BY 1`,
    );
    expect(gist.map((row) => row.index)).toEqual([
      "notable_places.places_geom_idx",
      "osm_search.places_geom_idx",
      "overture_places.osm_pois_geom_idx",
      "overture_places.places_geom_idx",
    ]);
    // Coordinates outside WGS 84 bounds are refused, as they were before.
    await expect(
      pg.sql.unsafe(
        `INSERT INTO osm_search.places (osm_type, osm_id, name, geom, tags, importance)
         VALUES ('node', 1, 'Off the map', ST_Point(13.4, 91, 4326), '{}', 0.5)`,
      ),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "places_geom_check" });
  });

  async function stage(schema: string, label: string): Promise<void> {
    await pg.sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pg.sql.unsafe(`CREATE SCHEMA "${schema}"`);
    await pg.sql.unsafe(buildPublicationFenceDDL(schema));
    await pg.sql.unsafe(`CREATE TABLE "${schema}".snapshot (label TEXT NOT NULL)`);
    await pg.sql.unsafe(`INSERT INTO "${schema}".snapshot VALUES ($1)`, [label]);
  }

  async function schemas(): Promise<string[]> {
    const rows = await pg.sql.unsafe<{ name: string }[]>(
      `SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'osm\\_search%' ORDER BY 1`,
    );
    return rows.map(({ name }) => name);
  }

  async function liveLabel(): Promise<string | undefined> {
    const [row] = await pg.sql.unsafe<{ label: string }[]>(`SELECT label FROM osm_search.snapshot`);
    return row?.label;
  }

  it("keeps the old schema while a reader outlasts the drop, and the next publication drops it first", async () => {
    await pg.sql.unsafe(`DROP SCHEMA IF EXISTS osm_search__previous CASCADE`);
    await stage("osm_search", "first");
    const holder = await reader.reserve();
    try {
      await holder.unsafe(`BEGIN`);
      await holder.unsafe(`SELECT count(*) FROM osm_search.snapshot`);

      await stage("osm_search__staging", "second");
      await publishSchemaSwap(pg.sql, {
        live: "osm_search",
        staging: "osm_search__staging",
        lockTimeoutMs: 100,
        retry: quickRetry,
      });
      expect(await liveLabel()).toBe("second");
      expect(await schemas()).toEqual(["osm_search", "osm_search__previous"]);
      const [kept] = await pg.sql.unsafe<{ label: string }[]>(
        `SELECT label FROM osm_search__previous.snapshot`,
      );
      expect(kept?.label).toBe("first");

      // While the reader still holds the leftover, a publication cannot start.
      await stage("osm_search__staging", "third");
      await expect(
        publishSchemaSwap(pg.sql, {
          live: "osm_search",
          staging: "osm_search__staging",
          lockTimeoutMs: 100,
          retry: quickRetry,
        }),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(await liveLabel()).toBe("second");

      await holder.unsafe(`COMMIT`);
      await publishSchemaSwap(pg.sql, {
        live: "osm_search",
        staging: "osm_search__staging",
        lockTimeoutMs: 100,
        retry: quickRetry,
      });
      expect(await liveLabel()).toBe("third");
      expect(await schemas()).toEqual(["osm_search"]);
    } finally {
      await holder.unsafe(`ROLLBACK`).catch(() => undefined);
      holder.release();
    }
  });

  it("leaves the live and staging schemas untouched when the swap's transaction fails", async () => {
    await stage("osm_search", "live");
    await stage("osm_search__staging", "staged");
    await expect(
      publishSchemaSwap(pg.sql, {
        live: "osm_search",
        staging: "osm_search__staging",
        retry: quickRetry,
        carryOver: async () => {
          throw new Error("injected carry-over failure");
        },
      }),
    ).rejects.toThrow("injected carry-over failure");
    expect(await liveLabel()).toBe("live");
    expect(await schemas()).toEqual(["osm_search", "osm_search__staging"]);
  });

  it("publishes the first snapshot when no live schema exists", async () => {
    await pg.sql.unsafe(`DROP SCHEMA IF EXISTS osm_search CASCADE`);
    await stage("osm_search__staging", "initial");
    const carried: (string | null)[] = [];
    await publishSchemaSwap(pg.sql, {
      live: "osm_search",
      staging: "osm_search__staging",
      retry: quickRetry,
      carryOver: async (_tx, previous) => {
        carried.push(previous);
      },
    });
    expect(carried).toEqual([null]);
    expect(await liveLabel()).toBe("initial");
    expect(await schemas()).toEqual(["osm_search"]);
    const [stats] = await pg.sql.unsafe<{ analyzed: boolean }[]>(
      `SELECT reltuples >= 0 AS analyzed FROM pg_class WHERE oid = 'osm_search.snapshot'::regclass`,
    );
    expect(stats?.analyzed).toBe(true);
  });

  async function fenceOid(schema: string): Promise<string | null> {
    const [row] = await pg.sql.unsafe<{ oid: string | null }[]>(
      `SELECT to_regclass($1)::OID::TEXT AS oid`,
      [`"${schema}".publication_fence`],
    );
    return row?.oid ?? null;
  }

  // A backup holds ACCESS SHARE on every table it dumps, the fence among them.
  async function withBackupLikeHolder(tables: string[], run: () => Promise<void>): Promise<void> {
    const holder = await reader.reserve();
    try {
      await holder.unsafe(`BEGIN ISOLATION LEVEL REPEATABLE READ`);
      for (const table of tables) await holder.unsafe(`LOCK TABLE ${table} IN ACCESS SHARE MODE`);
      await run();
    } finally {
      await holder.unsafe(`ROLLBACK`).catch(() => undefined);
      holder.release();
    }
  }

  it("waits for a backup that holds the fence, fails, and leaves the live schema readable", async () => {
    await pg.sql.unsafe(`DROP SCHEMA IF EXISTS osm_search__previous CASCADE`);
    await stage("osm_search", "live");
    await stage("osm_search__staging", "staged");
    const probe = postgres(pg.connectionString, {
      max: 1,
      connection: { statement_timeout: 500 },
    });
    try {
      await withBackupLikeHolder(["osm_search.publication_fence"], async () => {
        const publication = publishSchemaSwap(pg.sql, {
          live: "osm_search",
          staging: "osm_search__staging",
          retry: quickRetry,
        });
        // Readers never touch the fence, so the waiting publication queues nobody.
        await expect(probe.unsafe(`SELECT label FROM osm_search.snapshot`)).resolves.toEqual([
          { label: "live" },
        ]);
        await expect(publication).rejects.toMatchObject({ code: "55P03" });
      });
    } finally {
      await probe.end({ timeout: 2 });
    }
    expect(await liveLabel()).toBe("live");
    expect(await schemas()).toEqual(["osm_search", "osm_search__staging"]);

    // Once the backup has ended, the publication goes through and replaces the fence.
    const fence = await fenceOid("osm_search");
    const staged = await fenceOid("osm_search__staging");
    await publishSchemaSwap(pg.sql, {
      live: "osm_search",
      staging: "osm_search__staging",
      retry: quickRetry,
    });
    expect(await liveLabel()).toBe("staged");
    expect(await fenceOid("osm_search")).toBe(staged);
    expect(fence).not.toBe(staged);
    expect(await schemas()).toEqual(["osm_search"]);
  });

  it("refuses a staging schema without a fence", async () => {
    await stage("osm_search", "live");
    await stage("osm_search__staging", "unfenced");
    await pg.sql.unsafe(`DROP TABLE osm_search__staging.publication_fence`);
    await expect(
      publishSchemaSwap(pg.sql, {
        live: "osm_search",
        staging: "osm_search__staging",
        retry: quickRetry,
      }),
    ).rejects.toThrow('The staging schema "osm_search__staging" has no publication_fence table');
    expect(await liveLabel()).toBe("live");
  });

  it("retries a swap that lost a deadlock with a backup still taking its locks", async () => {
    await stage("osm_search", "live");
    await pg.sql.unsafe(
      `CREATE TABLE osm_search.snapshot_next (label TEXT NOT NULL);
       INSERT INTO osm_search.snapshot_next VALUES ('next')`,
    );
    // Like pg_dump in its lock phase: it holds the live table and asks for
    // the fence next, while the swap holds the fence and waits for the table.
    const backup = await reader.reserve();
    try {
      await backup.unsafe(`BEGIN ISOLATION LEVEL REPEATABLE READ`);
      // Only the swap's session checks for the deadlock within the test, so
      // the swap is always its victim.
      await backup.unsafe(`SET LOCAL deadlock_timeout = '60s'`);
      await backup.unsafe(`LOCK TABLE osm_search.snapshot IN ACCESS SHARE MODE`);
      const swap = publishTableSwap(pg.sql, {
        schema: "osm_search",
        live: "snapshot",
        staging: "snapshot_next",
        // Longer than the swap's deadlock_timeout (1 s), so the first wait
        // ends in the deadlock, which the swap detects and loses.
        lockTimeoutMs: 3000,
        retry: quickRetry,
      });
      const swapFailure = swap.catch((error: unknown) => error);
      const waitingForTable = async () => {
        const [row] = await pg.sql.unsafe<{ waiting: boolean }[]>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted
             AND relation = 'osm_search.snapshot'::regclass) AS waiting`,
        );
        return row?.waiting === true;
      };
      for (let attempt = 0; !(await waitingForTable()); attempt += 1) {
        if (attempt > 100) throw new Error("the swap never waited for the table");
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      const asked = Date.now();
      await backup.unsafe(`LOCK TABLE osm_search.publication_fence IN ACCESS SHARE MODE`);
      // The deadlock released the fence after about a second, not the 3 s timeout.
      expect(Date.now() - asked).toBeLessThan(2500);
      // The retry then waits for the backup, which now holds the fence, and times out.
      expect(await swapFailure).toMatchObject({ code: "55P03" });
    } finally {
      await backup.unsafe(`ROLLBACK`).catch(() => undefined);
      backup.release();
    }
    expect(await liveLabel()).toBe("live");
  });

  it("locks and replaces the fence when it swaps a single table", async () => {
    await stage("osm_search", "live");
    await pg.sql.unsafe(
      `CREATE TABLE osm_search.snapshot_next (label TEXT NOT NULL);
       INSERT INTO osm_search.snapshot_next VALUES ('next')`,
    );
    const swap = () =>
      publishTableSwap(pg.sql, {
        schema: "osm_search",
        live: "snapshot",
        staging: "snapshot_next",
        retry: quickRetry,
      });
    await withBackupLikeHolder(["osm_search.publication_fence"], async () => {
      await expect(swap()).rejects.toMatchObject({ code: "55P03" });
    });
    expect(await liveLabel()).toBe("live");
    const fence = await fenceOid("osm_search");
    await swap();
    expect(await liveLabel()).toBe("next");
    const replaced = await fenceOid("osm_search");
    expect(replaced).not.toBeNull();
    expect(replaced).not.toBe(fence);
  });
});
