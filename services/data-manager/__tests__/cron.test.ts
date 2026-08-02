import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduledJobs } from "croner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cron handlers reach the module-level drizzle `db` directly (e.g.
// `finalizeJobRow` in `runSync`/`runAutoBump`'s finally block). Against the
// real `postgres-js` pool there is no server in the unit env, so the query
// never resolves and the test hangs to the 15s timeout. Mock the db module to
// a chainable thenable that resolves immediately — no query ever executes.
vi.mock("../src/db/index.js", () => {
  const makeChain = (result: unknown[] = []) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(result),
      returning: () => Promise.resolve(result),
      insert: () => chain,
      values: () => chain,
      update: () => chain,
      set: () => chain,
      // Make the chain awaitable so a terminal `.where(...)`/`.values(...)`
      // resolves like a real drizzle query.
      // biome-ignore lint/suspicious/noThenProperty: mocks Drizzle's thenable query builder
      then: (onFulfilled: (v: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return chain;
  };
  return { db: makeChain(), sql: { end: async () => {} } };
});

import { awaitInflightSync, type CronSetupOptions, setupCron } from "../src/cron.js";
import {
  createSingleFlightController,
  type SingleFlightController,
} from "../src/jobs/transitous/single-flight.js";

interface JobRow {
  id: string;
  kind: string;
  status: string;
  triggeredBy: string | null;
  idempotencyKey: string | null;
  startedAt: Date;
}

/**
 * Real single-flight controller wired against a stub db. Because the real
 * controller uses drizzle's `and()` / `eq()` / `gt()` helpers, the predicate
 * never reaches the stub as a JS function — it arrives as a serialized SQL
 * tree we can't introspect cheaply. We work around this by patching the
 * controller's `db.select` so the where-clause checks fall back to the
 * recorded `idempotencyKey` + 24h window directly.
 */
function buildIdempotencyAwareDb(opts: { now: () => number; uuid: () => string }) {
  const rows: JobRow[] = [];

  const stub = {
    select() {
      return {
        from(_table: unknown) {
          return {
            where(_predicate: unknown) {
              // The real controller passes an `and(eq(idempotencyKey, key), gt(startedAt, cutoff))`.
              // For the test we approximate by inspecting the most-recent
              // arguments captured on the stub. We expose a side channel
              // through `(stub as any).__expectedKey` that tests set.
              return {
                orderBy() {
                  return {
                    limit(_n: number) {
                      const key = (stub as unknown as { __expectedKey?: string }).__expectedKey;
                      if (!key) return Promise.resolve([]);
                      const cutoff = opts.now() - 24 * 60 * 60 * 1000;
                      const found = rows
                        .filter((r) => r.idempotencyKey === key && r.startedAt.getTime() > cutoff)
                        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
                        .slice(0, _n);
                      return Promise.resolve(found.map((r) => ({ id: r.id })));
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(v: {
          kind: string;
          status: string;
          triggeredBy: string | null;
          idempotencyKey?: string | null;
          metadata?: unknown;
        }) {
          const row: JobRow = {
            id: opts.uuid(),
            kind: v.kind,
            status: v.status,
            triggeredBy: v.triggeredBy ?? null,
            idempotencyKey: v.idempotencyKey ?? null,
            startedAt: new Date(opts.now()),
          };
          rows.push(row);
          return {
            returning() {
              return Promise.resolve([{ id: row.id }]);
            },
          };
        },
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return { stub, rows };
}

describe("setupCron", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "openmapx-cron-"));
  });

  afterEach(() => {
    // Croner keeps a *global* named-job registry. A test that throws or times
    // out before its own `handles.stop()` runs would otherwise leak its named
    // jobs, and the next `setupCron` fails with "name already taken". Stop
    // everything still registered regardless of how the test ended. Iterate a
    // copy — `.stop()` mutates `scheduledJobs`.
    for (const job of [...scheduledJobs]) job.stop();
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeController(): SingleFlightController {
    let counter = 0;
    const { stub } = buildIdempotencyAwareDb({
      now: () => Date.now(),
      uuid: () => `job-${++counter}`,
    });
    return createSingleFlightController({ db: stub as never });
  }

  it("respects TRANSITOUS_SYNC_CRON=disabled by returning a null syncCron", () => {
    const handles = setupCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
    });
    expect(handles.syncCron).toBeNull();
    expect(handles.feedProxyReloadCron).toBeNull();
    handles.stop();
  });

  it("treats an empty cron expression (unset via compose) as the default, not disabled", () => {
    const handles = setupCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "",
      feedProxyReloadCronExpression: "",
    });
    // Unset-via-compose must fall through to the built-in schedule, not turn it off.
    expect(handles.syncCron).not.toBeNull();
    expect(handles.feedProxyReloadCron).not.toBeNull();
    handles.stop();
  });

  it("skips a scheduled run while another sync is in-flight", async () => {
    const controller = makeController();
    // Simulate an existing in-flight job by directly starting one.
    const first = await controller.tryStartSync({
      trigger: "manual",
      triggeredBy: "test",
    });
    expect(first.ok).toBe(true);

    const runPipeline = vi.fn().mockResolvedValue({
      jobId: "should-not-be-called",
      results: [],
      finalStatus: "ok" as const,
    });

    const handles = setupCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: controller,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "0 0 1 1 *", // far-future; we trigger manually
      feedProxyReloadCronExpression: "disabled",
      runPipeline,
    });

    await handles.runSyncNow();
    expect(runPipeline).not.toHaveBeenCalled();
    handles.stop();
  });

  it("opens a pipeline-failure issue when a scheduled sync ends in error", async () => {
    const createIssue = vi.fn(async (_title: string, _body: string) => "https://x/issues/1");
    const runPipeline = vi.fn().mockResolvedValue({
      jobId: "job-x",
      results: [
        { stage: "motis-health", status: "error" as const, error: { message: "rentals empty" } },
      ],
      finalStatus: "error" as const,
    });
    const handles = setupCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "0 0 1 1 *",
      feedProxyReloadCronExpression: "disabled",
      stalenessCheckCronExpression: "disabled",
      runPipeline,
      runStalenessCheck: async () => {},
      githubIssueSink: { findOpenIssueByTitle: async () => null, createIssue },
    });

    await handles.runSyncNow();
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledTimes(1);
    const [title, body] = createIssue.mock.calls[0] ?? [];
    expect(title).toContain("cron");
    expect(body).toContain("motis-health");
    handles.stop();
  });

  describe("auto-bump cron", () => {
    const ACTIVE = "a".repeat(40);
    const CANDIDATE = "e".repeat(40);
    const ATLAS_OLD = "b".repeat(40);
    const ATLAS_NEW = "c".repeat(40);
    const newCandidate = {
      branch: "main",
      ref: `main@${CANDIDATE}`,
      transitousSha: CANDIDATE,
      transitlandAtlasSha: ATLAS_NEW,
    };

    function seedRepo(): string {
      const repoRoot = join(dataDir, "repo");
      const lockDir = join(repoRoot, "infra", "docker");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, "transitous.lock.json"),
        JSON.stringify({
          ref: `main@${ACTIVE}`,
          submodules: { "transitland-atlas": ATLAS_OLD },
          lockedAt: "2026-05-01T00:00:00.000Z",
          lockedBy: "seed",
        }),
      );
      return repoRoot;
    }

    const activeLock = (repoRoot: string) =>
      JSON.parse(readFileSync(join(repoRoot, "infra/docker/transitous.lock.json"), "utf-8"));
    const proposalExists = (repoRoot: string) =>
      existsSync(join(repoRoot, "infra/docker/transitous.lock.proposed.json"));

    it("is opt-in — an unset schedule leaves the cron disabled", () => {
      const handles = setupCron({
        dataDir,
        repoRoot: seedRepo(),
        countries: [],
        store: {} as never,
        singleFlight: makeController(),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        syncCronExpression: "disabled",
        feedProxyReloadCronExpression: "disabled",
        stalenessCheckCronExpression: "disabled",
      });
      expect(handles.autoBumpCron).toBeNull();
      handles.stop();
    });

    it("activates the new pin when the canary passes", async () => {
      const repoRoot = seedRepo();
      const runBumpPipeline = vi.fn(async (_jobId: string) => ({
        jobId: "j",
        results: [],
        finalStatus: "ok" as const,
      }));
      const handles = setupCron({
        dataDir,
        repoRoot,
        countries: [],
        store: {} as never,
        singleFlight: makeController(),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        syncCronExpression: "disabled",
        feedProxyReloadCronExpression: "disabled",
        stalenessCheckCronExpression: "disabled",
        autoBumpCronExpression: "0 0 1 1 *",
        resolveBumpCandidate: async () => newCandidate,
        runBumpPipeline,
      });
      await handles.runAutoBumpNow();
      expect(runBumpPipeline).toHaveBeenCalledTimes(1);
      const active = activeLock(repoRoot);
      expect(active.ref).toBe(`main@${CANDIDATE}`);
      expect(active.submodules["transitland-atlas"]).toBe(ATLAS_NEW);
      expect(proposalExists(repoRoot)).toBe(false);
      handles.stop();
    });

    it("keeps the current pin, retains the proposal, and alerts when the canary rejects", async () => {
      const repoRoot = seedRepo();
      const createIssue = vi.fn(async (_t: string, _b: string) => "https://x/issues/1");
      const runBumpPipeline = vi.fn(async (_jobId: string) => {
        throw new Error('motis-health probe "rentals" failed: empty');
      });
      const handles = setupCron({
        dataDir,
        repoRoot,
        countries: [],
        store: {} as never,
        singleFlight: makeController(),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        syncCronExpression: "disabled",
        feedProxyReloadCronExpression: "disabled",
        stalenessCheckCronExpression: "disabled",
        autoBumpCronExpression: "0 0 1 1 *",
        resolveBumpCandidate: async () => newCandidate,
        runBumpPipeline,
        githubIssueSink: { findOpenIssueByTitle: async () => null, createIssue },
      });
      await handles.runAutoBumpNow();
      expect(activeLock(repoRoot).ref).toBe(`main@${ACTIVE}`);
      expect(proposalExists(repoRoot)).toBe(true);
      expect(createIssue).toHaveBeenCalledTimes(1);
      const [title] = createIssue.mock.calls[0] ?? [];
      expect(title).toContain("auto-bump");
      handles.stop();
    });

    it("does nothing when the active pin already matches upstream", async () => {
      const repoRoot = seedRepo();
      const runBumpPipeline = vi.fn(async (_jobId: string) => ({
        jobId: "j",
        results: [],
        finalStatus: "ok" as const,
      }));
      const handles = setupCron({
        dataDir,
        repoRoot,
        countries: [],
        store: {} as never,
        singleFlight: makeController(),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        syncCronExpression: "disabled",
        feedProxyReloadCronExpression: "disabled",
        stalenessCheckCronExpression: "disabled",
        autoBumpCronExpression: "0 0 1 1 *",
        resolveBumpCandidate: async () => ({
          branch: "main",
          ref: `main@${ACTIVE}`,
          transitousSha: ACTIVE,
          transitlandAtlasSha: ATLAS_OLD,
        }),
        runBumpPipeline,
      });
      await handles.runAutoBumpNow();
      expect(runBumpPipeline).not.toHaveBeenCalled();
      expect(proposalExists(repoRoot)).toBe(false);
      handles.stop();
    });
  });

  it("reloads the feed-proxy when default.conf is newer than the last reload", async () => {
    const confDir = join(dataDir, "motis-feed-proxy", "conf");
    mkdirSync(confDir, { recursive: true });
    const confPath = join(confDir, "default.conf");
    writeFileSync(confPath, "server { listen 80; }\n", "utf-8");

    const reload = vi.fn().mockResolvedValue(undefined);

    const handles = setupCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "0 0 1 1 *",
      reloadFeedProxy: reload,
    });

    // First run: file exists, no previous reload, so we should reload.
    await handles.runFeedProxyReloadNow();
    expect(reload).toHaveBeenCalledTimes(1);

    // Second run with no mtime change: should NOT reload.
    await handles.runFeedProxyReloadNow();
    expect(reload).toHaveBeenCalledTimes(1);

    // Bump mtime forward and re-run: should reload again.
    const future = Date.now() / 1000 + 60;
    utimesSync(confPath, future, future);
    await handles.runFeedProxyReloadNow();
    expect(reload).toHaveBeenCalledTimes(2);

    handles.stop();
  });

  it("does nothing when default.conf does not exist", async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const handles = setupCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "0 0 1 1 *",
      reloadFeedProxy: reload,
    });
    await handles.runFeedProxyReloadNow();
    expect(reload).not.toHaveBeenCalled();
    handles.stop();
  });

  describe("traffic-live cron", () => {
    function baseOptions(extra: Partial<CronSetupOptions>): CronSetupOptions {
      return {
        dataDir,
        repoRoot: "/tmp/nope",
        countries: [],
        store: {} as never,
        singleFlight: makeController(),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        syncCronExpression: "disabled",
        feedProxyReloadCronExpression: "disabled",
        ...extra,
      };
    }

    it("is not scheduled when OPENCONDITIONS_URL isn't configured, even with a valid cron expression", () => {
      const handles = setupCron(baseOptions({ trafficLiveCronExpression: "0 0 1 1 *" }));
      expect(handles.trafficLiveCron).toBeNull();
      handles.stop();
    });

    it("respects TRAFFIC_LIVE_CRON=disabled by returning a null trafficLiveCron", () => {
      const handles = setupCron(
        baseOptions({
          trafficLiveCronExpression: "disabled",
          openConditionsUrl: "http://openconditions-ingest:8080",
        }),
      );
      expect(handles.trafficLiveCron).toBeNull();
      handles.stop();
    });

    it("schedules the cron once both a schedule and OPENCONDITIONS_URL are configured", () => {
      const handles = setupCron(
        baseOptions({
          trafficLiveCronExpression: "0 0 1 1 *",
          openConditionsUrl: "http://openconditions-ingest:8080",
        }),
      );
      expect(handles.trafficLiveCron).not.toBeNull();
      handles.stop();
    });

    it("fetches the CSV, loads waysToEdges, writes live traffic, and logs the match rate", async () => {
      const fetchLiveTrafficCsv = vi
        .fn()
        .mockResolvedValue("way_id,dir,current_kph,free_flow_kph,los\n123,f,50,60,moderate");
      const waysToEdges = new Map([[123, [{ forward: true, level: 0, tile: 1, index: 0 }]]]);
      const loadWaysToEdges = vi.fn().mockResolvedValue(waysToEdges);
      const writeLiveTraffic = vi
        .fn()
        .mockResolvedValue({ written: 1, matched: 1, total: 1, outOfBounds: 0 });
      const infoLog = vi.fn();

      const handles = setupCron(
        baseOptions({
          trafficLiveCronExpression: "0 0 1 1 *",
          openConditionsUrl: "http://openconditions-ingest:8080",
          trafficTarPath: "/data/osm/traffic.tar",
          fetchLiveTrafficCsv,
          loadWaysToEdges,
          writeLiveTraffic,
          logger: { info: infoLog, warn: () => {}, error: () => {} },
        }),
      );

      await handles.runTrafficLiveNow();

      expect(fetchLiveTrafficCsv).toHaveBeenCalledTimes(1);
      expect(loadWaysToEdges).toHaveBeenCalledTimes(1);
      expect(writeLiveTraffic).toHaveBeenCalledWith(
        expect.objectContaining({
          tarPath: "/data/osm/traffic.tar",
          csv: "way_id,dir,current_kph,free_flow_kph,los\n123,f,50,60,moderate",
          waysToEdges,
          statePath: undefined,
        }),
      );
      expect(infoLog).toHaveBeenCalledWith(
        "traffic-live: cycle complete",
        expect.objectContaining({
          written: 1,
          matched: 1,
          total: 1,
          matchRatePct: 100,
          outOfBounds: 0,
        }),
      );

      handles.stop();
    });

    it("skips the cycle without fetching when OPENCONDITIONS_URL is unset (direct runTrafficLiveNow call)", async () => {
      const fetchLiveTrafficCsv = vi.fn();
      const handles = setupCron(baseOptions({ fetchLiveTrafficCsv }));

      await handles.runTrafficLiveNow();

      expect(fetchLiveTrafficCsv).not.toHaveBeenCalled();
      handles.stop();
    });

    it("bootstraps the way-to-edge map on startup when it is missing", async () => {
      const prev = process.env.DATA_DIR;
      // The map path derives from DATA_DIR; a fresh tmp dir has no traffic/ subdir.
      process.env.DATA_DIR = dataDir;
      try {
        const getCoveredWayIds = vi.fn().mockResolvedValue(new Set([123]));
        const refreshWaysToEdges = vi.fn().mockResolvedValue({ wayCount: 1, edgeCount: 2 });
        const handles = setupCron(
          baseOptions({
            openConditionsUrl: "http://openconditions-ingest:8080",
            ensureTrafficExtract: vi.fn().mockResolvedValue({ built: false }),
            getCoveredWayIds,
            refreshWaysToEdges,
          }),
        );

        await handles.runTrafficExtractStartupNow();

        expect(getCoveredWayIds).toHaveBeenCalledTimes(1);
        expect(refreshWaysToEdges).toHaveBeenCalledWith(new Set([123]), expect.anything());
        handles.stop();
      } finally {
        if (prev === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = prev;
      }
    });

    it("refreshes the way-to-edge map on the guard run even when no rebuild was needed", async () => {
      const refreshWaysToEdges = vi.fn().mockResolvedValue({ wayCount: 1, edgeCount: 2 });
      const handles = setupCron(
        baseOptions({
          openConditionsUrl: "http://openconditions-ingest:8080",
          isTrafficExtractStale: vi.fn().mockResolvedValue(false),
          ensureTrafficExtract: vi.fn().mockResolvedValue({ built: false }),
          getCoveredWayIds: vi.fn().mockResolvedValue(new Set([123])),
          refreshWaysToEdges,
        }),
      );

      await handles.runTrafficExtractGuardNow();

      // The map's key set tracks the OpenConditions feed, which grows without
      // the graph changing. Gating this on a rebuild let it run months stale.
      expect(refreshWaysToEdges).toHaveBeenCalledWith(new Set([123]), expect.anything());
      handles.stop();
    });

    it("still refreshes the map when the staleness check itself throws", async () => {
      const refreshWaysToEdges = vi.fn().mockResolvedValue({ wayCount: 1, edgeCount: 2 });
      const handles = setupCron(
        baseOptions({
          openConditionsUrl: "http://openconditions-ingest:8080",
          isTrafficExtractStale: vi.fn().mockRejectedValue(new Error("docker gone")),
          ensureTrafficExtract: vi.fn().mockResolvedValue({ built: false }),
          getCoveredWayIds: vi.fn().mockResolvedValue(new Set([123])),
          refreshWaysToEdges,
        }),
      );

      await handles.runTrafficExtractGuardNow();

      expect(refreshWaysToEdges).toHaveBeenCalledTimes(1);
      handles.stop();
    });

    it("does not bootstrap the map on startup when it already exists", async () => {
      const prev = process.env.DATA_DIR;
      process.env.DATA_DIR = dataDir;
      try {
        mkdirSync(join(dataDir, "traffic"), { recursive: true });
        writeFileSync(join(dataDir, "traffic", "ways_to_edges.json"), "{}");
        const refreshWaysToEdges = vi.fn();
        const handles = setupCron(
          baseOptions({
            openConditionsUrl: "http://openconditions-ingest:8080",
            ensureTrafficExtract: vi.fn().mockResolvedValue({ built: false }),
            getCoveredWayIds: vi.fn().mockResolvedValue(new Set([123])),
            refreshWaysToEdges,
          }),
        );

        await handles.runTrafficExtractStartupNow();

        expect(refreshWaysToEdges).not.toHaveBeenCalled();
        handles.stop();
      } finally {
        if (prev === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = prev;
      }
    });

    it("skips the startup map bootstrap when no covered-way-id source is configured", async () => {
      const prev = process.env.DATA_DIR;
      process.env.DATA_DIR = dataDir;
      try {
        const refreshWaysToEdges = vi.fn();
        const handles = setupCron(
          baseOptions({
            openConditionsUrl: "http://openconditions-ingest:8080",
            ensureTrafficExtract: vi.fn().mockResolvedValue({ built: false }),
            refreshWaysToEdges,
          }),
        );

        await handles.runTrafficExtractStartupNow();

        expect(refreshWaysToEdges).not.toHaveBeenCalled();
        handles.stop();
      } finally {
        if (prev === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = prev;
      }
    });
  });
});

describe("tryStartSync", () => {
  function makeController() {
    let counter = 0;
    const built = buildIdempotencyAwareDb({
      now: () => Date.now(),
      uuid: () => `job-${++counter}`,
    });
    return {
      controller: createSingleFlightController({ db: built.stub as never }),
      stub: built.stub as { __expectedKey?: string },
      rows: built.rows,
    };
  }

  /**
   * A controller whose INSERT can be held open, so tests can simulate two
   * `tryStartSync` calls racing inside the same in-flight window.
   */
  function makeGatedController() {
    let counter = 0;
    let releaseInsert: (() => void) | undefined;
    let failNextInsert = false;
    const gate = () =>
      new Promise<void>((resolve) => {
        releaseInsert = resolve;
      });
    let pendingGate: Promise<void> | null = null;

    const stub = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  orderBy() {
                    return { limit: () => Promise.resolve([]) };
                  },
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          values() {
            return {
              returning: async () => {
                if (pendingGate) await pendingGate;
                if (failNextInsert) {
                  failNextInsert = false;
                  throw new Error("insert failed");
                }
                return [{ id: `job-${++counter}` }];
              },
            };
          },
        };
      },
    };

    return {
      controller: createSingleFlightController({ db: stub as never }),
      holdInserts: () => {
        pendingGate = gate();
      },
      releaseInserts: () => {
        releaseInsert?.();
        pendingGate = null;
      },
      failNext: () => {
        failNextInsert = true;
      },
    };
  }

  it("only lets one of two concurrent calls start (latches before the first await)", async () => {
    const { controller, holdInserts, releaseInserts } = makeGatedController();
    holdInserts();

    const first = controller.tryStartSync({ trigger: "cron", triggeredBy: "x" });
    const second = await controller.tryStartSync({ trigger: "api", triggeredBy: "y" });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("in-flight");
      expect(second.existingJobId).toBeNull();
    }

    releaseInserts();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it("clears the latch when the INSERT rejects, so the next call can start", async () => {
    const { controller, failNext } = makeGatedController();
    failNext();

    await expect(controller.tryStartSync({ trigger: "cron", triggeredBy: "x" })).rejects.toThrow(
      "insert failed",
    );
    expect(controller.getInflight()).toBeNull();

    const retry = await controller.tryStartSync({ trigger: "cron", triggeredBy: "x" });
    expect(retry.ok).toBe(true);
  });

  it("surfaces concurrent same-idempotency-key calls as in-flight, not duplicate-idempotency-key", async () => {
    const { controller, holdInserts, releaseInserts } = makeGatedController();
    holdInserts();

    const first = controller.tryStartSync({
      trigger: "api",
      triggeredBy: "alice",
      idempotencyKey: "same-key",
    });
    const second = await controller.tryStartSync({
      trigger: "api",
      triggeredBy: "bob",
      idempotencyKey: "same-key",
    });

    // The `duplicate-idempotency-key` reason is reserved for replays that
    // arrive after the first insert has already landed; a concurrent
    // collision inside the starting window surfaces as "in-flight".
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("in-flight");
      expect(second.existingJobId).toBeNull();
    }

    releaseInserts();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it("returns in-flight error when a prior call has not finished", async () => {
    const { controller } = makeController();
    const first = await controller.tryStartSync({ trigger: "cron", triggeredBy: "x" });
    expect(first.ok).toBe(true);
    const second = await controller.tryStartSync({ trigger: "manual", triggeredBy: "y" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("in-flight");
      if (first.ok) expect(second.existingJobId).toBe(first.jobId);
    }
  });

  it("returns duplicate-idempotency-key when the key was used in <24h", async () => {
    const { controller, stub } = makeController();
    const first = await controller.tryStartSync({
      trigger: "api",
      triggeredBy: "alice",
      idempotencyKey: "dedup-key",
    });
    expect(first.ok).toBe(true);
    controller.markSyncFinished();

    // The stub looks up by `__expectedKey`; the real controller passes the
    // key through drizzle's `and()` filter — this back-channel mirrors that.
    stub.__expectedKey = "dedup-key";
    const replay = await controller.tryStartSync({
      trigger: "api",
      triggeredBy: "alice",
      idempotencyKey: "dedup-key",
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("duplicate-idempotency-key");
  });

  it("markSyncFinished clears the lock so the next call succeeds", async () => {
    const { controller } = makeController();
    const first = await controller.tryStartSync({ trigger: "cron", triggeredBy: "x" });
    expect(first.ok).toBe(true);
    controller.markSyncFinished();
    const second = await controller.tryStartSync({ trigger: "manual", triggeredBy: "y" });
    expect(second.ok).toBe(true);
  });
});

describe("awaitInflightSync", () => {
  it("returns 'finished' immediately when nothing is in-flight", async () => {
    let counter = 0;
    const { stub } = buildIdempotencyAwareDb({
      now: () => Date.now(),
      uuid: () => `job-${++counter}`,
    });
    const controller = createSingleFlightController({ db: stub as never });
    const status = await awaitInflightSync(controller, 100);
    expect(status).toBe("finished");
  });

  it("times out when the inflight flag is never cleared", async () => {
    let counter = 0;
    const { stub } = buildIdempotencyAwareDb({
      now: () => Date.now(),
      uuid: () => `job-${++counter}`,
    });
    const controller = createSingleFlightController({ db: stub as never });
    await controller.tryStartSync({ trigger: "cron", triggeredBy: "x" });
    const status = await awaitInflightSync(controller, 150, 25);
    expect(status).toBe("timeout");
  });
});
