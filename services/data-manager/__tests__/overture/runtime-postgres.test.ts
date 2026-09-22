import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseClient } from "@openmapx/integration-framework";
import { latLngToCell } from "h3-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveGers } from "../../../../integrations/knowledge-overture/provider.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import { type PostgisFixture, startPostgis } from "../poi-ingest/_testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

describe.skipIf(skipE2e)("Overture runtime behavior in PostGIS", () => {
  let pg: PostgisFixture;
  let previousDatabaseUrl: string | undefined;
  let dataManagerSql: { end: (options?: { timeout?: number }) => Promise<void> };
  let rebuildModule: typeof import("../../src/jobs/overture/rebuild-links.js");
  let ingestModule: typeof import("../../src/jobs/overture/ingest.js");
  let retentionModule: typeof import("../../src/jobs/overture/retention.js");

  beforeAll(async () => {
    pg = await startPostgis();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = pg.connectionString;
    vi.resetModules();
    rebuildModule = await import("../../src/jobs/overture/rebuild-links.js");
    ingestModule = await import("../../src/jobs/overture/ingest.js");
    retentionModule = await import("../../src/jobs/overture/retention.js");
    ({ sql: dataManagerSql } = (await import("../../src/db/index.js")) as unknown as {
      sql: typeof dataManagerSql;
    });
    await pg.sql.unsafe(buildSchemaDDL("overture_places"));
  }, 120_000);

  afterAll(async () => {
    await dataManagerSql?.end({ timeout: 2 });
    await pg?.stop();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("backfills 25,000 rows in key order, preserves prefilled values, and restarts after a failed batch", async () => {
    await pg.sql.unsafe(buildSchemaDDL("overture_h3test", { deferPlacesIndexes: true }));
    await ingestModule.backfillDerivedColumns("overture_h3test");
    await pg.sql.unsafe(`INSERT INTO overture_h3test.places (gers_id, geom, h3_r8, release)
      SELECT lpad(i::text, 8, '0'), ST_SetSRID(ST_MakePoint(8 + (i % 100) / 10000.0, 50),4326),
        CASE WHEN i % 7 = 0 THEN 'prefilled' ELSE NULL END, 'synthetic'
      FROM generate_series(25000,1,-1) i`);
    await pg.sql.unsafe(`CREATE FUNCTION overture_h3test.fail_late() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.gers_id > '00010000' THEN RAISE EXCEPTION 'injected late batch failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_late BEFORE UPDATE ON overture_h3test.places FOR EACH ROW EXECUTE FUNCTION overture_h3test.fail_late()`);
    await expect(ingestModule.backfillDerivedColumns("overture_h3test")).rejects.toThrow(
      "injected late batch failure",
    );
    const [partial] = await pg.sql.unsafe(
      `SELECT count(*)::int AS count FROM overture_h3test.places WHERE h3_r8 IS NOT NULL AND h3_r8 <> 'prefilled'`,
    );
    expect(partial.count).toBe(5000);
    await pg.sql.unsafe("DROP TRIGGER fail_late ON overture_h3test.places");
    await ingestModule.backfillDerivedColumns("overture_h3test");
    const rows = await pg.sql.unsafe<{ gers_id: string; h3_r8: string }[]>(
      "SELECT gers_id, h3_r8 FROM overture_h3test.places",
    );
    expect(rows).toHaveLength(25000);
    for (const row of rows) {
      const i = Number(row.gers_id);
      expect(row.h3_r8).toBe(
        i % 7 === 0 ? "prefilled" : latLngToCell(50, 8 + (i % 100) / 10000, 8),
      );
    }
    // An all-filled restart must perform no writes.
    await pg.sql.unsafe(
      `CREATE TRIGGER fail_late BEFORE UPDATE ON overture_h3test.places FOR EACH ROW EXECUTE FUNCTION overture_h3test.fail_late()`,
    );
    await ingestModule.backfillDerivedColumns("overture_h3test");
  }, 60_000);

  it("executes the spatial fallback with one SRID and resolves the nearby place", async () => {
    await pg.sql.unsafe(
      `INSERT INTO overture_places.places
         (gers_id, name, basic_category, taxonomy_primary, taxonomy_hierarchy,
          taxonomy_alternates, geom, h3_r8, release)
       VALUES
         ('gers-nearby', 'Café Aachen', 'cafe', 'cafe', ARRAY['cafe'], ARRAY[]::TEXT[],
          ST_SetSRID(ST_MakePoint(6.0839, 50.7753), 4326), '881f1d4887fffff', '2026-07-22.0'),
         ('gers-far', 'Café Aachen', 'cafe', 'cafe', ARRAY['cafe'], ARRAY[]::TEXT[],
          ST_SetSRID(ST_MakePoint(7.0000, 51.0000), 4326), '881f1d4887ffffe', '2026-07-22.0')`,
    );
    const database: DatabaseClient = {
      execute: (query, params = []) => pg.sql.unsafe(query, params as never[]),
    } as DatabaseClient;

    await expect(
      resolveGers(
        database,
        { amenity: "cafe" },
        {
          coordinates: [6.0838, 50.7752],
          name: "Cafe Aachen",
        },
      ),
    ).resolves.toBe("gers-nearby");
  });

  it("does not exclude east-west candidates inside 150 metres at European latitudes", async () => {
    await pg.sql.unsafe(
      `INSERT INTO overture_places.places
         (gers_id, name, basic_category, taxonomy_primary, taxonomy_hierarchy,
          taxonomy_alternates, geom, h3_r8, release)
       VALUES
         ('gers-east-120m', 'Eastside Cafe', 'cafe', 'cafe', ARRAY['cafe'],
          ARRAY[]::TEXT[],
          ST_Project(
            ST_SetSRID(ST_MakePoint(6.0838, 50.7752), 4326)::geography,
            120,
            RADIANS(90)
          )::geometry,
          '881f1d4887ffffd', '2026-07-22.0')`,
    );
    const database: DatabaseClient = {
      execute: (query, params = []) => pg.sql.unsafe(query, params as never[]),
    } as DatabaseClient;

    await expect(
      resolveGers(
        database,
        { amenity: "cafe" },
        {
          coordinates: [6.0838, 50.7752],
          name: "Eastside Cafe",
        },
      ),
    ).resolves.toBe("gers-east-120m");
  });

  it("persists a score crash, resumes from the durable phase, and invalidates on PBF change", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-overture-postgres-"));
    const osmDir = join(dataDir, "osm");
    mkdirSync(osmDir, { recursive: true });
    writeFileSync(join(osmDir, "europe-germany-berlin.osm.pbf"), "snapshot-one");
    await pg.sql.unsafe(
      `INSERT INTO overture_places.conflation_state
         (release, region, place_count, status)
       VALUES ('2026-07-22.0', 'europe/germany/berlin', 2, 'pending')`,
    );

    let fingerprint = "snapshot-one";
    let failScore = true;
    const dependencies = {
      fileExists: vi.fn(() => true),
      fingerprint: vi.fn(() => fingerprint),
      extract: vi.fn(async () => ({ emitted: 2, extracted: 2 })),
      score: vi.fn(async () => {
        if (failScore) {
          failScore = false;
          throw new Error("injected score crash");
        }
        return {
          candidates: 1,
          processed: 2,
          cursor: { h3: "881f1d4887fffff", osmType: "node", osmId: "1" },
        };
      }),
      assign: vi.fn(async () => ({ components: 1, assignmentCursor: 1, stagedLinks: 1 })),
      validateFusedQuality: vi.fn(async () => ({ applicableCases: 1, cases: [] })),
      publish: vi.fn(async () => ({ linked: 1 })),
      cleanup: vi.fn(async () => undefined),
      preflight: vi.fn(async () => undefined),
    };
    const options = {
      region: "europe/germany/berlin",
      release: "2026-07-22.0",
      dataDir,
    };

    try {
      await expect(
        rebuildModule.rebuildOvertureLinksUnlocked(options, dependencies as never),
      ).resolves.toEqual(
        expect.objectContaining({
          status: "failed",
          phase: "score",
          error: "injected score crash",
        }),
      );
      expect((await rebuildModule.getOvertureConflationState())?.phase).toBe("score");

      await expect(
        rebuildModule.rebuildOvertureLinksUnlocked(options, dependencies as never),
      ).resolves.toEqual(expect.objectContaining({ status: "completed", linked: 1 }));
      expect(dependencies.extract).toHaveBeenCalledTimes(1);
      expect(dependencies.score).toHaveBeenCalledTimes(2);
      expect(await rebuildModule.getOvertureConflationState()).toEqual(
        expect.objectContaining({
          status: "completed",
          phase: "complete",
          attemptCount: 2,
          workspaceCleanedAt: expect.any(Date),
        }),
      );

      await expect(
        retentionModule.finalizeOvertureReleaseFiles({
          dataDir,
          activeRelease: "2026-07-22.0",
          retain: 2,
        }),
      ).resolves.toEqual({ retained: [], removed: [] });
      await expect(
        retentionModule.finalizeOvertureReleaseFiles({
          dataDir,
          activeRelease: "2026-07-22.0",
          retain: 2,
        }),
      ).resolves.toBeNull();

      fingerprint = "snapshot-two";
      writeFileSync(join(osmDir, "europe-germany-berlin.osm.pbf"), "snapshot-two-expanded");
      await expect(
        rebuildModule.rebuildOvertureLinksUnlocked(options, dependencies as never),
      ).resolves.toEqual(expect.objectContaining({ status: "completed", linked: 1 }));
      expect(dependencies.extract).toHaveBeenCalledTimes(2);
      expect(await rebuildModule.getOvertureConflationState()).toEqual(
        expect.objectContaining({
          status: "completed",
          sourceFingerprint: "snapshot-two",
          attemptCount: 3,
        }),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("moves an unchanged OSM snapshot into a new Places release without copying it", async () => {
    const live = "overture_reuse_test";
    const staging = "overture_reuse_test__staging";
    await pg.sql.unsafe(buildSchemaDDL(live));
    await pg.sql.unsafe(buildSchemaDDL(staging));
    await pg.sql.unsafe(
      `INSERT INTO "${live}".osm_pois
         (osm_type, osm_id, name, lat, lng, h3_r8, category, tags)
       VALUES ('node', 42, 'Reusable POI', 50.7753, 6.0839, '881f1d4887fffff', 'cafes', '{}')`,
    );
    await pg.sql.unsafe(
      `INSERT INTO "${live}".conflation_state
         (release, region, place_count, status, phase, source_fingerprint,
          emitted_count, extracted_count)
       VALUES ('2026-07-22.0', 'europe/germany/berlin', 2, 'completed', 'complete',
               'same-pbf', 2, 1)`,
    );
    await pg.sql.unsafe(
      `INSERT INTO "${staging}".conflation_state
         (release, region, place_count, status)
       VALUES ('2026-08-19.0', 'europe/germany/berlin', 3, 'pending')`,
    );

    await ingestModule.activateOvertureStagingSchema(live, staging, "2026-09-10T12:00:00.000Z");

    // Conflation is a later, independent phase. A failed attempt must not
    // rewrite the timestamp that identifies the active Places release.
    await pg.sql.unsafe(
      `UPDATE "${live}".conflation_state SET status = 'failed' WHERE singleton = 1`,
    );

    const rows = await pg.sql.unsafe<{ osm_id: string }[]>(
      `SELECT osm_id::TEXT FROM "${live}".osm_pois`,
    );
    const state = await pg.sql.unsafe<
      {
        release: string;
        phase: string;
        source_fingerprint: string;
        extracted_count: string;
        places_published_at: Date;
      }[]
    >(
      `SELECT release, phase, source_fingerprint, extracted_count::TEXT,
              places_published_at
       FROM "${live}".conflation_state`,
    );
    expect(rows).toEqual([{ osm_id: "42" }]);
    expect(state).toEqual([
      {
        release: "2026-08-19.0",
        phase: "score",
        source_fingerprint: "same-pbf",
        extracted_count: "1",
        places_published_at: new Date("2026-09-10T12:00:00.000Z"),
      },
    ]);
  });
});
