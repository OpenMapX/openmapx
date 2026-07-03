import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { awaitInflightSync, setupCron } from "../src/cron.js";
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

  it("reloads the feed-proxy when feed-proxy.conf is newer than the last reload", async () => {
    const confDir = join(dataDir, "motis-feed-proxy", "conf");
    mkdirSync(confDir, { recursive: true });
    const confPath = join(confDir, "feed-proxy.conf");
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

  it("does nothing when feed-proxy.conf does not exist", async () => {
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
