import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseClient } from "@openmapx/integration-framework";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveGers } from "../../../../integrations/knowledge-overture/provider.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import { type PostgisFixture, startPostgis } from "../poi-ingest/_testcontainer.js";

const skipE2e = process.env.SKIP_TESTCONTAINERS === "1";

describe.skipIf(skipE2e)("Overture runtime behavior in PostGIS", () => {
  let pg: PostgisFixture;
  let previousDatabaseUrl: string | undefined;
  let dataManagerSql: { end: (options?: { timeout?: number }) => Promise<void> };
  let capacityModule: typeof import("../../src/jobs/overture/capacity.js");
  let rebuildModule: typeof import("../../src/jobs/overture/rebuild-links.js");
  let ingestModule: typeof import("../../src/jobs/overture/ingest.js");
  let retentionModule: typeof import("../../src/jobs/overture/retention.js");

  beforeAll(async () => {
    pg = await startPostgis();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = pg.connectionString;
    vi.resetModules();
    capacityModule = await import("../../src/jobs/overture/capacity.js");
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

  it("measures free space on the PostgreSQL container filesystem", async () => {
    const [{ data_directory: dataDirectory }] = await pg.sql.unsafe<{ data_directory: string }[]>(
      `SELECT current_setting('data_directory') AS data_directory`,
    );
    await expect(
      capacityModule.freeBytesInPostgresContainer(dataDirectory, pg.container.getId()),
    ).resolves.toBeGreaterThan(0);
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

    await ingestModule.activateOvertureStagingSchema(live, staging);

    const rows = await pg.sql.unsafe<{ osm_id: string }[]>(
      `SELECT osm_id::TEXT FROM "${live}".osm_pois`,
    );
    const state = await pg.sql.unsafe<
      {
        release: string;
        phase: string;
        source_fingerprint: string;
        extracted_count: string;
      }[]
    >(
      `SELECT release, phase, source_fingerprint, extracted_count::TEXT
       FROM "${live}".conflation_state`,
    );
    expect(rows).toEqual([{ osm_id: "42" }]);
    expect(state).toEqual([
      {
        release: "2026-08-19.0",
        phase: "score",
        source_fingerprint: "same-pbf",
        extracted_count: "1",
      },
    ]);
  });
});
