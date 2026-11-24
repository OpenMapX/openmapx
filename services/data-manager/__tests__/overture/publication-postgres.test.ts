import { setTimeout as sleep } from "node:timers/promises";
import { openMapXCategoryToOvertureConcepts } from "@openmapx/core/places/overtureCategoryMap";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assignOvertureCandidates,
  cleanupOvertureConflationWorkspace,
  publishOvertureLinks,
} from "../../src/jobs/overture/conflate.js";
import { cosineSimilarity, embed, SqlEmbeddingCache } from "../../src/jobs/overture/embeddings.js";
import { OVERTURE_QUALITY_BASELINE } from "../../src/jobs/overture/eval/quality-baseline.js";
import {
  validateFusedOvertureQuality,
  validateOvertureQuality,
} from "../../src/jobs/overture/eval/quality-gate.js";
import { publishOsmPoisSnapshot } from "../../src/jobs/overture/extract-osm-pois.js";
import { activateOvertureStagingSchema } from "../../src/jobs/overture/ingest.js";
import {
  getOvertureConflationState,
  rebuildOvertureLinksUnlocked,
} from "../../src/jobs/overture/rebuild-links.js";
import { buildOsmPoisTableDDL, buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import { type PostgisFixture, startPostgis } from "../helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";
const OLLAMA_URL = "http://ollama.test";
const FAST_RETRY = { attempts: 2, backoffMs: 10 };

function fetchReturning(embedding: number[]) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ embedding }) }) as Response);
}

// Deterministic stand-ins for 1024-dimensional model vectors: a shared
// direction plus a differently weighted, differently shaped deviation each.
function fixtureVector(weight: number, seed: number): number[] {
  return Array.from(
    { length: 1024 },
    (_, i) => Math.sin(i * 0.731 + 0.2) + weight * Math.sin(i * (1.37 + seed) + seed),
  );
}

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

  const scoredCursor = {
    cursor: { h3: "881f1d4887fffff", osmType: "node", osmId: "2" },
    processed: 1,
    candidates: 1,
  };

  // A backup leaves candidates, components and staged links out, while it
  // keeps the published links and the state of the run it overlapped. A run
  // whose workspace is in place resumes where it stopped.
  it.each([
    {
      phase: "score",
      workspace: "missing",
      progress: `processed_count = 1, candidate_count = 1,
        score_cursor_h3 = x'881f1d4887fffff'::BIGINT, score_cursor_type = 'node', score_cursor_id = 2`,
      rows: [] as [string, number, string][],
      restarts: true,
      scored: [undefined] as unknown[],
    },
    {
      phase: "assign",
      workspace: "missing",
      progress: `processed_count = 2, candidate_count = 2, component_count = 2,
        assignment_cursor = 1, staged_link_count = 1`,
      rows: [],
      restarts: true,
      scored: [undefined],
    },
    {
      phase: "publish",
      workspace: "missing",
      progress: `processed_count = 2, candidate_count = 2, component_count = 2,
        assignment_cursor = 2, staged_link_count = 2`,
      rows: [],
      restarts: true,
      scored: [undefined],
    },
    {
      phase: "score",
      workspace: "present",
      progress: `processed_count = 1, candidate_count = 1,
        score_cursor_h3 = x'881f1d4887fffff'::BIGINT, score_cursor_type = 'node', score_cursor_id = 2`,
      rows: [["poi_conflation_candidate", 2, "g1"]],
      restarts: false,
      scored: [scoredCursor],
    },
    {
      phase: "assign",
      workspace: "present",
      progress: "processed_count = 2, candidate_count = 2",
      rows: [
        ["poi_conflation_candidate", 2, "g1"],
        ["poi_conflation_candidate", 3, "g2"],
      ],
      restarts: false,
      scored: [],
    },
    {
      phase: "publish",
      workspace: "present",
      progress: `processed_count = 2, candidate_count = 2, component_count = 2,
        assignment_cursor = 2, staged_link_count = 2`,
      rows: [
        ["poi_conflation_link_next", 2, "g1"],
        ["poi_conflation_link_next", 3, "g2"],
      ],
      restarts: false,
      scored: [],
    },
  ])(
    "resumes conflation in $phase only when its workspace is $workspace and restarts otherwise",
    async ({ phase, progress, rows, restarts, scored: expectedScores }) => {
      await pg.sql.unsafe(buildSchemaDDL("overture_places"));
      await insertPlace("overture_places", "g1", "First");
      await insertPlace("overture_places", "g2", "Second");
      await insertLink("poi_conflation_link", 1, "g1");
      await pg.sql.unsafe(
        `INSERT INTO overture_places.conflation_state
         (release, region, place_count, status, phase, attempt_count, source_fingerprint,
          emitted_count, extracted_count, sources_catalogue, updated_at)
       VALUES ('2026-07-22.0', 'europe/germany/berlin', 2, 'running', $1, 1, 'snapshot',
               2, 2, '[]', now() - interval '1 hour')`,
        [phase],
      );
      await pg.sql.unsafe(`UPDATE overture_places.conflation_state SET ${progress}`);
      for (const [table, osmId, gersId] of rows) await insertLink(table, osmId, gersId);
      const scored: unknown[] = [];
      const dependencies = {
        fileExists: () => true,
        fingerprint: () => "snapshot",
        extract: vi.fn(async () => ({ emitted: 2, extracted: 2 })),
        score: async (options: { resume?: unknown }) => {
          scored.push(options.resume);
          await pg.sql.unsafe(
            `INSERT INTO overture_places.poi_conflation_candidate
               (osm_type, osm_id, gers_id, match_confidence, distance_m, method, evidence, release)
             VALUES ('node', 2, 'g1', 0.9, 3, 'name', '{}', 'test'),
                    ('node', 3, 'g2', 0.9, 3, 'name', '{}', 'test')
             ON CONFLICT DO NOTHING`,
          );
          return {
            candidates: 2,
            processed: 2,
            cursor: { h3: "881f1d4887fffff", osmType: "node", osmId: "3" },
          };
        },
        assign: assignOvertureCandidates,
        validateFusedQuality: async () => ({ applicableCases: 1, cases: [] }),
        publish: publishOvertureLinks,
        cleanup: cleanupOvertureConflationWorkspace,
        preflight: async () => undefined,
      };

      await expect(
        rebuildOvertureLinksUnlocked(
          {
            sql: pg.sql,
            region: "europe/germany/berlin",
            release: "2026-07-22.0",
            dataDir: "/nonexistent",
          },
          dependencies as never,
        ),
      ).resolves.toEqual(expect.objectContaining({ status: "completed", linked: 2 }));
      expect(dependencies.extract).toHaveBeenCalledTimes(restarts ? 1 : 0);
      expect(scored).toEqual(expectedScores);
      expect(
        await search.unsafe(
          `SELECT osm_id::TEXT, gers_id FROM overture_places.poi_conflation_link ORDER BY osm_id`,
        ),
      ).toEqual([
        { osm_id: "2", gers_id: "g1" },
        { osm_id: "3", gers_id: "g2" },
      ]);
      expect(await getOvertureConflationState(pg.sql)).toEqual(
        expect.objectContaining({ status: "completed", phase: "complete", attemptCount: 2 }),
      );
    },
    60_000,
  );

  it("refuses, rather than restarts, staged links that only partly match the recorded count", async () => {
    await pg.sql.unsafe(buildSchemaDDL("overture_places"));
    await insertPlace("overture_places", "g1", "First");
    await insertPlace("overture_places", "g2", "Second");
    await insertLink("poi_conflation_link", 1, "g1");
    await insertLink("poi_conflation_link_next", 2, "g1");
    await pg.sql.unsafe(
      `INSERT INTO overture_places.conflation_state
         (release, region, place_count, status, phase, attempt_count, source_fingerprint,
          emitted_count, extracted_count, candidate_count, staged_link_count, sources_catalogue)
       VALUES ('2026-07-22.0', 'europe/germany/berlin', 2, 'failed', 'publish', 1, 'snapshot',
               2, 2, 2, 2, '[]')`,
    );
    const extract = vi.fn(async () => ({ emitted: 2, extracted: 2 }));
    await expect(
      rebuildOvertureLinksUnlocked(
        {
          sql: pg.sql,
          region: "europe/germany/berlin",
          release: "2026-07-22.0",
          dataDir: "/nonexistent",
        },
        {
          fileExists: () => true,
          fingerprint: () => "snapshot",
          extract,
          score: vi.fn(),
          assign: vi.fn(),
          validateFusedQuality: vi.fn(),
          publish: publishOvertureLinks,
          cleanup: cleanupOvertureConflationWorkspace,
          preflight: async () => undefined,
        } as never,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        phase: "publish",
        error: expect.stringContaining("refusing to publish it"),
      }),
    );
    expect(extract).not.toHaveBeenCalled();
    expect(
      await search.unsafe(`SELECT osm_id::TEXT FROM overture_places.poi_conflation_link`),
    ).toEqual([{ osm_id: "1" }]);
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
    const constraints = await pg.sql.unsafe<{ name: string }[]>(
      `SELECT conname AS name FROM pg_constraint
        WHERE conrelid = 'overture_places.osm_pois'::regclass AND contype IN ('c', 'p')
        ORDER BY 1`,
    );
    expect(constraints.map(({ name }) => name)).toEqual(["osm_pois_geom_check", "osm_pois_pkey"]);
    const [stats] = await pg.sql.unsafe<{ analyzed: boolean }[]>(
      `SELECT reltuples >= 0 AS analyzed FROM pg_class
        WHERE oid = 'overture_places.osm_pois'::regclass`,
    );
    expect(stats?.analyzed).toBe(true);
  }, 60_000);

  describe("embedding cache", () => {
    beforeAll(async () => {
      await pg.sql.unsafe(buildSchemaDDL("overture_places"));
    });

    async function publishNewRelease(): Promise<void> {
      await pg.sql.unsafe(buildSchemaDDL("overture_places__staging"));
      await activateOvertureStagingSchema(
        pg.sql,
        "overture_places",
        "overture_places__staging",
        new Date().toISOString(),
        FAST_RETRY,
      );
    }

    it("keeps cached embeddings across an Overture release and uses them", async () => {
      const vector = [0.5, -0.25, 0.125];
      const firstFetch = fetchReturning(vector);
      await expect(
        embed(["Café Central Hauptstraße 1"], {
          ollamaUrl: OLLAMA_URL,
          fetchImpl: firstFetch,
          cache: new SqlEmbeddingCache(pg.sql),
        }),
      ).resolves.toEqual([vector]);
      expect(firstFetch).toHaveBeenCalledTimes(1);

      await publishNewRelease();

      const secondFetch = fetchReturning([9, 9, 9]);
      await expect(
        embed(["Café Central Hauptstraße 1"], {
          ollamaUrl: OLLAMA_URL,
          fetchImpl: secondFetch,
          cache: new SqlEmbeddingCache(pg.sql),
        }),
      ).resolves.toEqual([vector]);
      expect(secondFetch).not.toHaveBeenCalled();
    });

    it("publishes a release while another build holds an uncommitted cache write", async () => {
      await new SqlEmbeddingCache(reader).get("0".repeat(64));
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let written!: () => void;
      const insideWrite = new Promise<void>((resolve) => {
        written = resolve;
      });
      const transaction = reader.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO overture_embeddings.embedding_cache (text_hash, model, embedding)
           VALUES ($1, 'mxbai-embed-large', '{1,2,3}') ON CONFLICT (text_hash) DO NOTHING`,
          ["1".repeat(64)],
        );
        written();
        await held;
      });
      await insideWrite;
      try {
        await publishNewRelease();
        const [previous] = await pg.sql<{ exists: boolean }[]>`
          SELECT to_regnamespace('overture_places__previous') IS NOT NULL AS exists`;
        expect(previous?.exists).toBe(false);
      } finally {
        release();
        await transaction;
      }
    });

    it("lets two builds create the cache and store the same text at once", async () => {
      await pg.sql.unsafe("DROP SCHEMA IF EXISTS overture_embeddings CASCADE");
      const hash = "2".repeat(64);
      await Promise.all([
        new SqlEmbeddingCache(reader).set(hash, "mxbai-embed-large", [0.5]),
        new SqlEmbeddingCache(probe).set(hash, "mxbai-embed-large", [0.75]),
      ]);
      const rows = await pg.sql<{ count: number }[]>`
        SELECT COUNT(*)::INTEGER AS count FROM overture_embeddings.embedding_cache
        WHERE text_hash = ${hash}`;
      expect(rows[0]?.count).toBe(1);
    });

    it("stores the vectors as real[] in its own schema with conventional names", async () => {
      await new SqlEmbeddingCache(pg.sql).get("3".repeat(64));
      const columns = await pg.sql<{ column: string; type: string; notNull: boolean }[]>`
        SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
               a.attnotnull AS "notNull"
          FROM pg_attribute a
         WHERE a.attrelid = 'overture_embeddings.embedding_cache'::regclass
           AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`;
      expect(columns).toEqual([
        { column: "text_hash", type: "text", notNull: true },
        { column: "model", type: "text", notNull: true },
        { column: "embedding", type: "real[]", notNull: true },
        { column: "created_at", type: "timestamp with time zone", notNull: true },
      ]);
      const constraints = await pg.sql<{ name: string }[]>`
        SELECT conname AS name FROM pg_constraint
         WHERE conrelid = 'overture_embeddings.embedding_cache'::regclass AND contype <> 'n'
         ORDER BY 1`;
      expect(constraints.map(({ name }) => name)).toEqual(["embedding_cache_pkey"]);
      const [inSwappedSchema] = await pg.sql<{ exists: boolean }[]>`
        SELECT to_regclass('overture_places.embedding_cache') IS NOT NULL AS exists`;
      expect(inSwappedSchema?.exists).toBe(false);
    });

    it("keeps cosine similarities of cached vectors within float4 precision", async () => {
      const anchor = fixtureVector(0, 0);
      const others = [0.1, 0.4, 1, 3].map((weight, index) => fixtureVector(weight, index + 1));
      const cache = new SqlEmbeddingCache(pg.sql);
      const vectors = [anchor, ...others];
      const hashes = vectors.map((_, index) => String(index + 4).repeat(64));
      for (const [index, vector] of vectors.entries()) {
        const hash = hashes[index];
        if (hash === undefined) throw new Error("fixture hash missing");
        await cache.set(hash, "mxbai-embed-large", vector);
      }
      const cached = await Promise.all(
        hashes.map(async (hash) => {
          const vector = await cache.get(hash);
          if (!vector) throw new Error(`cached vector ${hash} missing`);
          return vector;
        }),
      );
      const [cachedAnchor, ...cachedOthers] = cached;
      if (!cachedAnchor) throw new Error("cached anchor missing");

      const fromCache = cachedOthers.map((vector) => cosineSimilarity(cachedAnchor, vector));
      // Read back from a double precision cache, which returned the vectors exactly.
      const recorded = [0.995034842983, 0.928535047538, 0.707201943626, 0.320149923959];
      expect(others.map((vector) => cosineSimilarity(anchor, vector))).toEqual(
        recorded.map((value) => expect.closeTo(value, 11)),
      );
      expect(fromCache).toHaveLength(recorded.length);
      for (const [index, value] of fromCache.entries()) {
        expect(Math.abs(value - (recorded[index] ?? Number.NaN))).toBeLessThan(1e-7);
      }
    });
  });

  describe("quality gates on the case's box", () => {
    const cafes = OVERTURE_QUALITY_BASELINE.find((entry) => entry.id === "aachen-centre-cafes");
    if (!cafes) throw new Error("missing Aachen café baseline");
    const baseline = { ...cafes, judgments: [], minimumResultCount: 0, minimumRelevantRecall: 0 };
    const { west, south, east, north } = baseline.bbox;
    // A billionth of a degree is far below float4 precision, so a bounding box
    // overlap alone would still count the last record.
    const positions: [string, number, number][] = [
      ["Inside", (west + east) / 2, (south + north) / 2],
      ["Boundary", east, (south + north) / 2],
      ["Outside", (west + east) / 2, north + 1e-9],
    ];

    it("counts OSM POIs on the box and none just outside it", async () => {
      await pg.sql.unsafe(buildSchemaDDL("overture_places"));
      for (const [index, [name, lng, lat]] of positions.entries()) {
        await pg.sql.unsafe(
          `INSERT INTO overture_places.osm_pois (osm_type, osm_id, name, geom, h3_r8, category)
           VALUES ('node', $1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326),
                   x'881f1d4887fffff'::BIGINT, $5)`,
          [index + 1, `${name} Café`, lng, lat, baseline.category],
        );
      }

      const fused = await validateFusedOvertureQuality(pg.sql, "overture_places", baseline.region, [
        baseline,
      ]);
      expect(fused.cases.map(({ resultCount }) => resultCount)).toEqual([2]);
    });

    it("counts Overture places on the box and none just outside it", async () => {
      await pg.sql.unsafe(buildSchemaDDL("overture_places"));
      const [concept] = openMapXCategoryToOvertureConcepts(baseline.category);
      if (!concept) throw new Error(`no Overture concept for ${baseline.category}`);
      for (const [name, lng, lat] of positions) {
        await pg.sql.unsafe(
          `INSERT INTO overture_places.places (gers_id, name, basic_category, geom, h3_r8, release)
           VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326),
                   x'881f1d4887fffff'::BIGINT, 'test')`,
          [`gers-${name.toLowerCase()}`, `${name} Coffee`, concept, lng, lat],
        );
      }

      const staged = await validateOvertureQuality(pg.sql, "overture_places", baseline.region, [
        baseline,
      ]);
      expect(staged.cases.map(({ resultCount }) => resultCount)).toEqual([2]);
      const fused = await validateFusedOvertureQuality(pg.sql, "overture_places", baseline.region, [
        baseline,
      ]);
      expect(fused.cases.map(({ resultCount }) => resultCount)).toEqual([2]);
    });
  });
});
