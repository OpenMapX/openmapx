import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupOvertureConflationWorkspace,
  publishOvertureLinks,
} from "../../src/jobs/overture/conflate.js";
import { publishOsmPoisSnapshot } from "../../src/jobs/overture/extract-osm-pois.js";
import { activateOvertureStagingSchema } from "../../src/jobs/overture/ingest.js";
import {
  getOvertureConflationState,
  rebuildOvertureLinksUnlocked,
} from "../../src/jobs/overture/rebuild-links.js";
import { buildOsmPoisTableDDL, buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import { type PostgisFixture, startPostgis } from "../helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

async function waitUntil(check: () => Promise<boolean>, label: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

describe.skipIf(skipE2e)("Overture publication beside readers", () => {
  let pg: PostgisFixture;
  let reader: postgres.Sql;
  let probe: postgres.Sql;
  let search: postgres.Sql;

  beforeAll(async () => {
    pg = await startPostgis();
    reader = postgres(pg.connectionString, { max: 1 });
    probe = postgres(pg.connectionString, { max: 1 });
    // The API's integration pool ends a statement after 5 seconds.
    search = postgres(pg.connectionString, { max: 1, connection: { statement_timeout: 5000 } });
  }, 120_000);

  afterAll(async () => {
    await reader?.end({ timeout: 2 });
    await probe?.end({ timeout: 2 });
    await search?.end({ timeout: 2 });
    await pg?.stop();
  });

  async function insertPlace(schema: string, gersId: string, name: string): Promise<void> {
    await pg.sql.unsafe(
      `INSERT INTO "${schema}".places (gers_id, name, geom, h3_r8, release)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint(6.08, 50.77), 4326), x'881f1d4887fffff'::BIGINT, 'test')`,
      [gersId, name],
    );
  }

  async function insertLink(table: string, osmId: number, gersId: string): Promise<void> {
    await pg.sql.unsafe(
      `INSERT INTO overture_places."${table}"
         (osm_type, osm_id, gers_id, match_confidence, distance_m, method, evidence, release)
       VALUES ('node', $1, $2, 0.9, 3, 'name', '{}', 'test')`,
      [osmId, gersId],
    );
  }

  async function relationNames(pattern: string): Promise<string[]> {
    const rows = await pg.sql.unsafe<{ name: string }[]>(
      `SELECT relname AS name FROM pg_class
        WHERE relnamespace = 'overture_places'::regnamespace AND relname LIKE $1 ORDER BY 1`,
      [pattern],
    );
    return rows.map(({ name }) => name);
  }

  it("activates a release and carries the OSM snapshot over while a reader holds the old places", async () => {
    await pg.sql.unsafe(buildSchemaDDL("overture_places"));
    await pg.sql.unsafe(buildSchemaDDL("overture_places__staging"));
    await insertPlace("overture_places", "old-place", "Old Café");
    await insertPlace("overture_places__staging", "new-place", "New Café");
    await pg.sql.unsafe(
      `INSERT INTO overture_places.osm_pois (osm_type, osm_id, name, geom, h3_r8, category, tags)
       VALUES ('node', 42, 'Carried POI', ST_Point(6.08, 50.77, 4326), x'881f1d4887fffff'::BIGINT, 'cafes', '{}')`,
    );
    for (const [schema, release] of [
      ["overture_places", "2026-07-22.0"],
      ["overture_places__staging", "2026-08-19.0"],
    ] as const) {
      await pg.sql.unsafe(
        `INSERT INTO "${schema}".conflation_state
           (release, region, place_count, status, phase, source_fingerprint, extracted_count,
            sources_catalogue)
         VALUES ($1, 'europe/germany', 1, 'pending', 'extract', $2, $3, '[]')`,
        [
          release,
          schema === "overture_places" ? "same-pbf" : null,
          schema === "overture_places" ? 1 : null,
        ],
      );
    }

    // Like pg_dump, the reader holds its lock until its transaction ends.
    const holder = await reader.reserve();
    try {
      await holder.unsafe(`BEGIN ISOLATION LEVEL REPEATABLE READ`);
      await holder.unsafe(`SELECT count(*) FROM overture_places.places`);

      const activation = activateOvertureStagingSchema(
        pg.sql,
        "overture_places",
        "overture_places__staging",
        "2026-09-10T12:00:00.000Z",
        // Outlasts the 12-second reader without the production pauses.
        { attempts: 10, backoffMs: 250 },
      );
      activation.catch(() => undefined);
      await waitUntil(async () => {
        const [state] = await probe.unsafe<{ waiting: boolean; staged: boolean }[]>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted) AS waiting,
                  to_regnamespace('overture_places__staging') IS NOT NULL AS staged`,
        );
        return Boolean(state?.waiting) || !state?.staged;
      }, "the activation to swap or wait for a lock");
      const swappedAt = Date.now();

      const startedAt = Date.now();
      expect(await search.unsafe(`SELECT name FROM overture_places.places`)).toEqual([
        { name: "New Café" },
      ]);
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(await search.unsafe(`SELECT osm_id::TEXT FROM overture_places.osm_pois`)).toEqual([
        { osm_id: "42" },
      ]);
      expect(
        await search.unsafe(
          `SELECT release, phase, source_fingerprint FROM overture_places.conflation_state`,
        ),
      ).toEqual([{ release: "2026-08-19.0", phase: "score", source_fingerprint: "same-pbf" }]);

      await sleep(Math.max(0, swappedAt + 12_000 - Date.now()));
      await holder.unsafe(`COMMIT`);
      await activation;
    } finally {
      holder.release();
    }
    const [previous] = await pg.sql.unsafe<{ exists: boolean }[]>(
      `SELECT to_regnamespace('overture_places__previous') IS NOT NULL AS exists`,
    );
    expect(previous?.exists).toBe(false);
  }, 60_000);

  it("swaps the link snapshot in by renaming and waits for its readers only briefly", async () => {
    await pg.sql.unsafe(buildSchemaDDL("overture_places"));
    await insertPlace("overture_places", "g1", "First");
    await insertPlace("overture_places", "g2", "Second");
    await insertLink("poi_conflation_link", 1, "g1");
    await insertLink("poi_conflation_link_next", 2, "g1");
    await insertLink("poi_conflation_link_next", 3, "g2");
    const [next] = await pg.sql.unsafe<{ oid: number }[]>(
      `SELECT 'overture_places.poi_conflation_link_next'::regclass::OID AS oid`,
    );
    const linkedIds = () =>
      search.unsafe<{ osm_id: string }[]>(
        `SELECT osm_id::TEXT FROM overture_places.poi_conflation_link ORDER BY osm_id`,
      );

    const holder = await reader.reserve();
    try {
      await holder.unsafe(`BEGIN`);
      await holder.unsafe(`SELECT count(*) FROM overture_places.poi_conflation_link`);
      const startedAt = Date.now();
      await expect(
        publishOvertureLinks(pg.sql, "overture_places", {
          retry: { attempts: 2, backoffMs: 10 },
        }),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(await linkedIds()).toEqual([{ osm_id: "1" }]);
      expect(await relationNames("poi_conflation_link%")).toEqual([
        "poi_conflation_link",
        "poi_conflation_link_gers_id_key",
        "poi_conflation_link_next",
        "poi_conflation_link_next_gers_id_key",
        "poi_conflation_link_next_pkey",
        "poi_conflation_link_pkey",
      ]);
      await holder.unsafe(`COMMIT`);
    } finally {
      holder.release();
    }

    // A reader of the places the links point at does not hold the swap up.
    const placesHolder = await reader.reserve();
    try {
      await placesHolder.unsafe(`BEGIN`);
      await placesHolder.unsafe(`SELECT count(*) FROM overture_places.places`);
      await expect(publishOvertureLinks(pg.sql, "overture_places")).resolves.toEqual({
        linked: 2,
      });
      await placesHolder.unsafe(`COMMIT`);
    } finally {
      placesHolder.release();
    }
    expect(await linkedIds()).toEqual([{ osm_id: "2" }, { osm_id: "3" }]);
    const [published] = await pg.sql.unsafe<{ oid: number; next: string }[]>(
      `SELECT 'overture_places.poi_conflation_link'::regclass::OID AS oid,
              (SELECT count(*) FROM overture_places.poi_conflation_link_next)::TEXT AS next`,
    );
    expect(published).toEqual({ oid: next?.oid, next: "0" });
    expect(await relationNames("poi_conflation_link%")).toEqual([
      "poi_conflation_link",
      "poi_conflation_link_gers_id_key",
      "poi_conflation_link_next",
      "poi_conflation_link_next_gers_id_key",
      "poi_conflation_link_next_pkey",
      "poi_conflation_link_pkey",
    ]);
    const constraints = await pg.sql.unsafe<{ table: string; name: string; kind: string }[]>(
      `SELECT conrelid::regclass::TEXT AS table, conname AS name, contype::TEXT AS kind
         FROM pg_constraint
        WHERE conrelid IN ('overture_places.poi_conflation_link'::regclass,
                           'overture_places.poi_conflation_link_next'::regclass)
          AND contype <> 'n'
        ORDER BY 1, 2`,
    );
    expect(constraints).toEqual(
      ["poi_conflation_link", "poi_conflation_link_next"].flatMap((table) => [
        { table: `overture_places.${table}`, name: `${table}_distance_m_check`, kind: "c" },
        { table: `overture_places.${table}`, name: `${table}_gers_id_key`, kind: "u" },
        { table: `overture_places.${table}`, name: `${table}_match_confidence_check`, kind: "c" },
        { table: `overture_places.${table}`, name: `${table}_pkey`, kind: "p" },
      ]),
    );
    // Not-null constraints follow their table's name too.
    const [notNull] = await pg.sql.unsafe<{ names: string[] }[]>(
      `SELECT array_agg(conname::TEXT ORDER BY conname) AS names FROM pg_constraint
        WHERE conrelid = 'overture_places.poi_conflation_link'::regclass AND contype = 'n'`,
    );
    expect(
      notNull?.names.every((name) => /^poi_conflation_link_[a-z_]+_not_null$/.test(name)),
    ).toBe(true);
    expect(notNull?.names.some((name) => name.startsWith("poi_conflation_link_next_"))).toBe(false);
  }, 60_000);

  it("keeps the published links when a conflation run fails after its links were swapped in", async () => {
    await pg.sql.unsafe(buildSchemaDDL("overture_places"));
    await insertPlace("overture_places", "g1", "First");
    await insertPlace("overture_places", "g2", "Second");
    await insertLink("poi_conflation_link", 1, "g1");
    await pg.sql.unsafe(
      `INSERT INTO overture_places.conflation_state
         (release, region, place_count, status, sources_catalogue)
       VALUES ('2026-07-22.0', 'europe/germany/berlin', 2, 'pending', '[]')`,
    );
    let failAfterSwap = true;
    const dependencies = {
      fileExists: () => true,
      fingerprint: () => "snapshot",
      extract: async () => ({ emitted: 2, extracted: 2 }),
      score: async () => ({
        candidates: 2,
        processed: 2,
        cursor: { h3: "881f1d4887fffff", osmType: "node", osmId: "3" },
      }),
      assign: async () => {
        await insertLink("poi_conflation_link_next", 2, "g1");
        await insertLink("poi_conflation_link_next", 3, "g2");
        return { components: 2, assignmentCursor: 2, stagedLinks: 2 };
      },
      validateFusedQuality: async () => ({ applicableCases: 1, cases: [] }),
      publish: async (...args: Parameters<typeof publishOvertureLinks>) => {
        const published = await publishOvertureLinks(...args);
        if (failAfterSwap) {
          failAfterSwap = false;
          throw new Error("injected failure after the swap committed");
        }
        return published;
      },
      cleanup: cleanupOvertureConflationWorkspace,
      preflight: async () => undefined,
    };
    const options = {
      sql: pg.sql,
      region: "europe/germany/berlin",
      release: "2026-07-22.0",
      dataDir: "/nonexistent",
    };
    const linkedIds = () =>
      search.unsafe<{ osm_id: string }[]>(
        `SELECT osm_id::TEXT FROM overture_places.poi_conflation_link ORDER BY osm_id`,
      );

    await expect(rebuildOvertureLinksUnlocked(options, dependencies as never)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        error: "injected failure after the swap committed",
      }),
    );
    expect(await linkedIds()).toEqual([{ osm_id: "2" }, { osm_id: "3" }]);

    // The run completed with the swap, so a rerun does not publish again.
    await expect(rebuildOvertureLinksUnlocked(options, dependencies as never)).resolves.toEqual({
      status: "already_completed",
      linked: 2,
    });
    expect(await linkedIds()).toEqual([{ osm_id: "2" }, { osm_id: "3" }]);
    expect(await getOvertureConflationState(pg.sql)).toEqual(
      expect.objectContaining({ status: "completed", phase: "complete", linkedCount: 2 }),
    );

    // The next snapshot is empty now, and assignment recorded two links.
    await expect(publishOvertureLinks(pg.sql)).rejects.toThrow(
      "The staged link snapshot holds 0 links but assignment recorded 2; refusing to publish it",
    );
    expect(await linkedIds()).toEqual([{ osm_id: "2" }, { osm_id: "3" }]);
  }, 60_000);

  it("indexes and analyzes the OSM POI snapshot before swapping it in", async () => {
    await pg.sql.unsafe(buildSchemaDDL("overture_places"));
    await pg.sql.unsafe(
      `INSERT INTO overture_places.osm_pois (osm_type, osm_id, name, geom, h3_r8, category, tags)
       VALUES ('node', 1, 'Old POI', ST_Point(6.08, 50.77, 4326), x'881f1d4887fffff'::BIGINT, 'cafes', '{}')`,
    );
    // The staging table as the extraction creates and fills it.
    await pg.sql.unsafe(buildOsmPoisTableDDL("overture_places", "osm_pois__staging"));
    await pg.sql.unsafe(
      `INSERT INTO overture_places.osm_pois__staging
         (osm_type, osm_id, name, geom, h3_r8, category, tags)
       VALUES ('node', 2, 'New POI', ST_Point(6.09, 50.78, 4326), x'881f1d4887fffff'::BIGINT, 'bars', '{}')`,
    );

    await publishOsmPoisSnapshot(pg.sql, "overture_places");

    expect(await search.unsafe(`SELECT name FROM overture_places.osm_pois`)).toEqual([
      { name: "New POI" },
    ]);
    expect(await relationNames("%osm_pois%")).toEqual([
      "osm_pois",
      "osm_pois_category_idx",
      "osm_pois_geom_idx",
      "osm_pois_h3_r8_osm_type_osm_id_idx",
      "osm_pois_pkey",
    ]);
    const [stats] = await pg.sql.unsafe<{ analyzed: boolean }[]>(
      `SELECT reltuples >= 0 AS analyzed FROM pg_class
        WHERE oid = 'overture_places.osm_pois'::regclass`,
    );
    expect(stats?.analyzed).toBe(true);
  }, 60_000);
});
