import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OVERTURE_PLACES_SCHEMA_VERSION } from "@openmapx/core/published-data";
import type { DatabaseClient } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bindDb as bindKnowledgeDb,
  overtureKnowledgeSource,
  resolveGers,
} from "../../../../integrations/knowledge-overture/provider.js";
import {
  overtureProvider,
  setup as setupPoiOverture,
} from "../../../../integrations/poi-overture/index.js";
import { buildSchemaDDL } from "../../src/jobs/overture/schema.js";
import { type PostgisFixture, startPostgis } from "../helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

interface ReservedConnection {
  unsafe: (query: string) => PromiseLike<Record<string, unknown>[]>;
  release: () => void;
}

interface ServiceSql {
  end: (options?: { timeout?: number }) => Promise<void>;
  reserve: () => Promise<ReservedConnection>;
  unsafe: (query: string) => PromiseLike<unknown[]>;
}

const noop = () => undefined;

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Fails the test instead of hanging when something never settles. */
async function withDeadline<T>(work: PromiseLike<T>, label: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(skipE2e)("Overture runtime behavior in PostGIS", () => {
  let pg: PostgisFixture;
  let previousDatabaseUrl: string | undefined;
  let dataManagerSql: postgres.Sql;
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
    ({ sql: dataManagerSql } = await import("../../src/db/index.js"));
    await pg.sql.unsafe(buildSchemaDDL("overture_places"));
  }, 120_000);

  /** Runs `work` while the fixtures' release is the snapshot readers may serve. */
  async function withPublishedRelease(work: () => Promise<void>): Promise<void> {
    await pg.sql.unsafe(
      `INSERT INTO overture_places.conflation_state
         (release, region, place_count, status, sources_catalogue, schema_version)
       VALUES ('2026-07-22.0', 'europe/germany/berlin', 1, 'completed',
               '[{"sourceId":"overture","name":"Overture Maps"}]', $1)`,
      [OVERTURE_PLACES_SCHEMA_VERSION],
    );
    try {
      await work();
    } finally {
      await pg.sql.unsafe(`DELETE FROM overture_places.conflation_state`);
    }
  }

  afterAll(async () => {
    await dataManagerSql?.end({ timeout: 2 });
    await pg?.stop();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("joins conflation_state.sources_catalogue for POI and knowledge reads and fails closed on missing or mismatched release", async () => {
    await pg.sql.unsafe(
      `INSERT INTO overture_places.places
         (gers_id, name, basic_category, taxonomy_primary, taxonomy_hierarchy,
          taxonomy_alternates, geom, h3_r8, sources, release)
       VALUES
         ('gers-join', 'Join Cafe', 'cafe', 'cafe', ARRAY['cafe'], ARRAY[]::TEXT[],
          ST_SetSRID(ST_MakePoint(6.0839, 50.7753), 4326), x'881f1d4887fffff'::BIGINT,
          '[{"property":"","dataset":"meta"}]', '2026-07-22.0')`,
    );
    const database: DatabaseClient = {
      execute: <T>(query: string, params: unknown[] = []) =>
        pg.sql.unsafe(query, params as never[]) as unknown as Promise<T>,
    };
    setupPoiOverture(createMockIntegrationContext({ db: database }));
    bindKnowledgeDb(database);

    // Without conflation_state, INNER JOIN fails closed rather than serving uncredited rows.
    const bbox = { west: 6.08, south: 50.77, east: 6.09, north: 50.78 };
    const withoutState = await overtureProvider.search("cafes", bbox);
    expect(Array.isArray(withoutState) ? withoutState : withoutState.results).toEqual([]);
    await expect(
      overtureKnowledgeSource.lookup({}, "en", { ids: { overture: "gers-join" } }),
    ).resolves.toBeNull();

    // Matching release exposes captured sources_catalogue receipts from conflation_state.
    await pg.sql.unsafe(
      `INSERT INTO overture_places.conflation_state
         (release, region, place_count, status, sources_catalogue, schema_version)
       VALUES
         ('2026-07-22.0', 'europe/germany/berlin', 1, 'completed',
          '[{"sourceId":"overture","name":"Overture Maps"},{"sourceId":"meta-places","name":"Meta Places"}]', 1)`,
    );
    const withState = await overtureProvider.search("cafes", bbox);
    const results = Array.isArray(withState) ? withState : withState.results;
    expect(results).toHaveLength(1);
    expect(results[0]?.contributors?.map((c) => c.sourceId).sort()).toEqual([
      "meta-places",
      "overture",
    ]);
    const knowledge = await overtureKnowledgeSource.lookup({}, "en", {
      ids: { overture: "gers-join" },
    });
    expect(knowledge?.externalIds?.gers).toBe("gers-join");
    expect(knowledge?.contributors?.map((c) => c.sourceId)).toEqual(["overture"]);

    // A release mismatch between places and conflation_state also fails closed.
    await pg.sql.unsafe(`UPDATE overture_places.conflation_state SET release = '2026-08-19.0'`);
    const mismatched = await overtureProvider.search("cafes", bbox);
    expect(Array.isArray(mismatched) ? mismatched : mismatched.results).toEqual([]);
    await expect(
      overtureKnowledgeSource.lookup({}, "en", { ids: { overture: "gers-join" } }),
    ).resolves.toBeNull();

    await pg.sql.unsafe(
      `DELETE FROM overture_places.conflation_state; DELETE FROM overture_places.places WHERE gers_id = 'gers-join'`,
    );
  });

  it("executes the spatial fallback with one SRID and resolves the nearby place", async () => {
    await pg.sql.unsafe(
      `INSERT INTO overture_places.places
         (gers_id, name, basic_category, taxonomy_primary, taxonomy_hierarchy,
          taxonomy_alternates, geom, h3_r8, release)
       VALUES
         ('gers-nearby', 'Café Aachen', 'cafe', 'cafe', ARRAY['cafe'], ARRAY[]::TEXT[],
          ST_SetSRID(ST_MakePoint(6.0839, 50.7753), 4326), x'881f1d4887fffff'::BIGINT, '2026-07-22.0'),
         ('gers-far', 'Café Aachen', 'cafe', 'cafe', ARRAY['cafe'], ARRAY[]::TEXT[],
          ST_SetSRID(ST_MakePoint(7.0000, 51.0000), 4326), x'881f1d4887ffffe'::BIGINT, '2026-07-22.0')`,
    );
    const database: DatabaseClient = {
      execute: (query, params = []) => pg.sql.unsafe(query, params as never[]),
    } as DatabaseClient;

    await withPublishedRelease(() =>
      expect(
        resolveGers(
          database,
          { amenity: "cafe" },
          {
            coordinates: [6.0838, 50.7752],
            name: "Cafe Aachen",
          },
        ),
      ).resolves.toBe("gers-nearby"),
    );
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
          x'881f1d4887ffffd'::BIGINT, '2026-07-22.0')`,
    );
    const database: DatabaseClient = {
      execute: (query, params = []) => pg.sql.unsafe(query, params as never[]),
    } as DatabaseClient;

    await withPublishedRelease(() =>
      expect(
        resolveGers(
          database,
          { amenity: "cafe" },
          {
            coordinates: [6.0838, 50.7752],
            name: "Eastside Cafe",
          },
        ),
      ).resolves.toBe("gers-east-120m"),
    );
  });

  it("persists a score crash, resumes from the durable phase, and invalidates on PBF change", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-overture-postgres-"));
    const osmDir = join(dataDir, "osm");
    mkdirSync(osmDir, { recursive: true });
    writeFileSync(join(osmDir, "europe-germany-berlin.osm.pbf"), "snapshot-one");
    await pg.sql.unsafe(
      `INSERT INTO overture_places.conflation_state
         (release, region, place_count, status, sources_catalogue, schema_version)
       VALUES ('2026-07-22.0', 'europe/germany/berlin', 2, 'pending', '[{"sourceId":"overture","name":"Overture Maps"}]', 1)`,
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
      // Like the real publication, completes the run inside the swap.
      publish: vi.fn(
        async (
          transaction: postgres.TransactionSql,
          _schema: string,
          options?: {
            complete?: (tx: postgres.TransactionSql, linked: number) => Promise<void>;
          },
        ) => {
          await options?.complete?.(transaction, 1);
          return { linked: 1 };
        },
      ),
      cleanup: vi.fn(async () => undefined),
      preflight: vi.fn(async () => undefined),
    };
    const options = {
      sql: dataManagerSql,
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
      expect((await rebuildModule.getOvertureConflationState(dataManagerSql))?.phase).toBe("score");

      await expect(
        rebuildModule.rebuildOvertureLinksUnlocked(options, dependencies as never),
      ).resolves.toEqual(expect.objectContaining({ status: "completed", linked: 1 }));
      expect(dependencies.extract).toHaveBeenCalledTimes(1);
      expect(dependencies.score).toHaveBeenCalledTimes(2);
      expect(await rebuildModule.getOvertureConflationState(dataManagerSql)).toEqual(
        expect.objectContaining({
          status: "completed",
          phase: "complete",
          attemptCount: 2,
          workspaceCleanedAt: expect.any(Date),
          // Stored as a bigint, reported as the cell scoring returned.
          scoreCursorH3: "881f1d4887fffff",
        }),
      );
      const [storedCursor] = await dataManagerSql.unsafe<{ type: string; value: string }[]>(
        `SELECT pg_typeof(score_cursor_h3)::TEXT AS type, score_cursor_h3::TEXT AS value
           FROM overture_places.conflation_state`,
      );
      expect(storedCursor).toEqual({ type: "bigint", value: "613036919424548863" });

      await expect(
        retentionModule.finalizeOvertureReleaseFiles({
          sql: dataManagerSql,
          dataDir,
          activeRelease: "2026-07-22.0",
          retain: 2,
        }),
      ).resolves.toEqual({ retained: [], removed: [] });
      await expect(
        retentionModule.finalizeOvertureReleaseFiles({
          sql: dataManagerSql,
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
      expect(await rebuildModule.getOvertureConflationState(dataManagerSql)).toEqual(
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

  describe("operation lock", () => {
    let harnessCount = 0;

    /**
     * One disposable service module and pool per case, so a regression that
     * wedges the pool or the helper's local queue cannot reach another case.
     * The pool is the real max-4 client; only its sessions are tagged.
     */
    async function openLockHarness() {
      harnessCount += 1;
      const applicationName = `overture-lock-test-${harnessCount}`;
      const url = new URL(pg.connectionString);
      url.searchParams.set("application_name", applicationName);
      const outerDatabaseUrl = process.env.DATABASE_URL;
      let service: {
        sql: ServiceSql;
        lock: typeof import("../../src/jobs/overture/operation-lock.js");
      };
      process.env.DATABASE_URL = url.toString();
      try {
        vi.resetModules();
        service = {
          sql: ((await import("../../src/db/index.js")) as unknown as { sql: ServiceSql }).sql,
          lock: await import("../../src/jobs/overture/operation-lock.js"),
        };
      } finally {
        if (outerDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = outerDatabaseUrl;
      }
      const { sql, lock } = service;
      const owned: Promise<unknown>[] = [];
      const held = new Set<ReservedConnection>();
      const gates: Deferred[] = [];
      const settled = (label: string, ms: number) =>
        withDeadline(Promise.allSettled(owned), label, ms);
      const sessionsGone = async (ms: number) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          const [row] = await pg.sql.unsafe(
            `SELECT count(*)::int AS count FROM pg_stat_activity
             WHERE datname = current_database() AND application_name = $1`,
            [applicationName],
          );
          if (row?.count === 0) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("timed out waiting for the service sessions to disconnect");
      };
      const terminateSessions = () =>
        pg.sql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = current_database() AND application_name = $1`,
          [applicationName],
        );

      return {
        sql,
        lock,
        /** Starts tracking work so a failure never leaves it unobserved. */
        own<T>(work: PromiseLike<T>): Promise<T> {
          const pending = Promise.resolve(work);
          owned.push(pending.then(noop, noop));
          return pending;
        },
        gate(): Deferred {
          const gate = deferred();
          gates.push(gate);
          return gate;
        },
        /** Reserves a service connection; one that arrives after a timeout is still released. */
        reserve(): Promise<ReservedConnection> {
          const pending = this.own(
            Promise.resolve(sql.reserve()).then((connection) => {
              held.add(connection);
              return connection;
            }),
          );
          return withDeadline(pending, "a service connection");
        },
        release(connection: ReservedConnection) {
          if (held.delete(connection)) connection.release();
        },
        /** Ends everything the case started, however it ended. */
        async close(caseFailed: boolean) {
          for (const gate of gates) gate.resolve();
          const errors: unknown[] = [];
          let clean = true;
          try {
            await settled("lock work to finish", 3_000);
          } catch (error) {
            clean = false;
            if (!caseFailed) errors.push(error);
          }
          if (clean) {
            for (const connection of held) {
              held.delete(connection);
              try {
                connection.release();
              } catch (error) {
                errors.push(error);
              }
            }
          } else {
            // A regression can leave sessions blocked inside PostgreSQL, so the
            // pool cannot drain. Terminate only this case's tagged sessions.
            await terminateSessions().catch((error) => errors.push(error));
          }
          try {
            // Destroying the pool also rejects whatever is still queued on it.
            await withDeadline(sql.end({ timeout: 0 }), "the service pool to end", 5_000);
            if (!clean) await settled("lock work after the pool ended", 5_000);
            await sessionsGone(5_000);
          } catch (error) {
            errors.push(error);
          }
          if (errors.length) throw new AggregateError(errors, "lock case cleanup failed");
        },
      };
    }
    type LockHarness = Awaited<ReturnType<typeof openLockHarness>>;

    /** Runs a case and always closes its harness; a cleanup failure never hides the case failure. */
    async function inLockHarness(body: (harness: LockHarness) => Promise<void>) {
      const harness = await openLockHarness();
      let failure: unknown;
      let failed = false;
      try {
        await body(harness);
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await harness.close(failed);
      } catch (cleanupError) {
        if (!failed) throw cleanupError;
        throw new AggregateError(
          [failure, cleanupError],
          `${failure instanceof Error ? failure.message : String(failure)} (cleanup also failed)`,
        );
      }
      if (failed) throw failure;
    }

    /** Observes real lock attempts made through the service pool; mocks nothing. */
    function observeLockAttempts(harness: LockHarness) {
      const attempts: boolean[] = [];
      const failedAttempt = deferred();
      const reserve = harness.sql.reserve.bind(harness.sql);
      vi.spyOn(harness.sql, "reserve").mockImplementation(async () => {
        const connection = await reserve();
        const unsafe = connection.unsafe.bind(connection);
        connection.unsafe = (query: string) => {
          const pending = unsafe(query);
          if (query.includes("pg_try_advisory_lock")) {
            void Promise.resolve(pending).then((rows) => {
              const locked = rows[0]?.locked === true;
              attempts.push(locked);
              if (!locked) failedAttempt.resolve();
            }, noop);
          }
          return pending;
        };
        return connection;
      });
      return { attempts, failedAttempt: failedAttempt.promise };
    }

    it(
      "keeps queued callers out of the four-connection service pool",
      () =>
        inLockHarness(async (harness) => {
          const gate = harness.gate();
          const ownerEntered = deferred();
          const entered: string[] = [];
          let active = 0;
          let maxActive = 0;
          const run = (name: string) =>
            harness.own(
              harness.lock.withOvertureOperationLock(async () => {
                entered.push(name);
                if (name === "a") ownerEntered.resolve();
                active += 1;
                maxActive = Math.max(maxActive, active);
                try {
                  if (name === "a") await gate.promise;
                  // The owner needs an ordinary pooled connection to finish.
                  await harness.sql.unsafe("SELECT pg_sleep(0.01)");
                  return name;
                } finally {
                  active -= 1;
                }
              }),
            );
          const calls = ["a", "b", "c", "d"].map(run);
          await withDeadline(ownerEntered.promise, "the first caller to own the lock");
          // Unrelated service queries still get a connection while three callers wait.
          await withDeadline(harness.own(harness.sql.unsafe("SELECT 1")), "an unrelated query");
          expect(entered).toEqual(["a"]);
          gate.resolve();
          await expect(withDeadline(Promise.all(calls), "all queued callers")).resolves.toEqual([
            "a",
            "b",
            "c",
            "d",
          ]);
          expect(entered).toEqual(["a", "b", "c", "d"]);
          expect(maxActive).toBe(1);
        }),
      45_000,
    );

    it.each([
      { mode: "exclusive", acquire: "pg_advisory_lock", release: "pg_advisory_unlock" },
      {
        mode: "shared",
        acquire: "pg_advisory_lock_shared",
        release: "pg_advisory_unlock_shared",
      },
    ])(
      "waits for an external $mode holder without occupying the service pool",
      ({ acquire, release }) =>
        inLockHarness(async (harness) => {
          const keys = `${harness.lock.OVERTURE_LOCK_NAMESPACE}, ${harness.lock.OVERTURE_LOCK_KEY}`;
          const holder = await pg.sql.reserve();
          const observer = observeLockAttempts(harness);
          let holding = false;
          let ran = false;
          try {
            await holder.unsafe(`SELECT ${acquire}(${keys})`);
            holding = true;
            const result = harness.own(
              harness.lock.withOvertureOperationLock(async () => {
                ran = true;
                return "done";
              }),
            );
            await withDeadline(observer.failedAttempt, "a refused lock attempt");
            expect(ran).toBe(false);

            // During backoff the helper holds no service connection at all.
            const reservations: ReservedConnection[] = [];
            for (let i = 0; i < 4; i += 1) reservations.push(await harness.reserve());
            expect(ran).toBe(false);
            for (const reservation of reservations) harness.release(reservation);

            await holder.unsafe(`SELECT ${release}(${keys})`);
            holding = false;
            await expect(withDeadline(result, "the lock holder to release")).resolves.toBe("done");
            expect(observer.attempts.at(-1)).toBe(true);

            // The helper's lock is gone once it returns.
            const probe = await pg.sql.reserve();
            try {
              const [row] = await probe.unsafe(`SELECT pg_try_advisory_lock(${keys}) AS locked`);
              expect(row?.locked).toBe(true);
              await probe.unsafe(`SELECT pg_advisory_unlock(${keys})`);
            } finally {
              probe.release();
            }
          } finally {
            if (holding) await holder.unsafe(`SELECT ${release}(${keys})`).catch(noop);
            holder.release();
          }
        }),
      45_000,
    );
  });

  it("moves an unchanged OSM snapshot into a new Places release without copying it", async () => {
    const live = "overture_places";
    const staging = "overture_places__staging";
    await pg.sql.unsafe(buildSchemaDDL(live));
    await pg.sql.unsafe(buildSchemaDDL(staging));
    await pg.sql.unsafe(
      `INSERT INTO "${live}".osm_pois
         (osm_type, osm_id, name, geom, h3_r8, category, tags)
       VALUES ('node', 42, 'Reusable POI', ST_Point(6.0839, 50.7753, 4326), x'881f1d4887fffff'::BIGINT, 'cafes', '{}')`,
    );
    await pg.sql.unsafe(
      `INSERT INTO "${live}".conflation_state
         (release, region, place_count, status, phase, source_fingerprint,
          emitted_count, extracted_count, sources_catalogue, schema_version)
       VALUES ('2026-07-22.0', 'europe/germany/berlin', 2, 'completed', 'complete',
               'same-pbf', 2, 1, '[{"sourceId":"overture","name":"Old Overture"}]', 1)`,
    );
    await pg.sql.unsafe(
      `INSERT INTO "${staging}".conflation_state
         (release, region, place_count, status, sources_catalogue, schema_version)
       VALUES ('2026-08-19.0', 'europe/germany/berlin', 3, 'pending',
               '[{"sourceId":"overture","name":"New Overture"}]', 1)`,
    );

    await ingestModule.activateOvertureStagingSchema(
      dataManagerSql,
      live,
      staging,
      "2026-09-10T12:00:00.000Z",
    );

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
        sources_catalogue: unknown;
        places_published_at_ms: string;
      }[]
    >(
      `SELECT release, phase, source_fingerprint, extracted_count::TEXT, sources_catalogue,
              (EXTRACT(EPOCH FROM places_published_at) * 1000)::BIGINT::TEXT
                AS places_published_at_ms
       FROM "${live}".conflation_state`,
    );
    expect(rows).toEqual([{ osm_id: "42" }]);
    expect(state).toEqual([
      {
        release: "2026-08-19.0",
        phase: "score",
        source_fingerprint: "same-pbf",
        extracted_count: "1",
        sources_catalogue: [{ sourceId: "overture", name: "New Overture" }],
        places_published_at_ms: String(Date.parse("2026-09-10T12:00:00.000Z")),
      },
    ]);
  });
});
