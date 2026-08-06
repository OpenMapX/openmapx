import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupCron } from "../../src/cron.js";
import {
  createSingleFlightController,
  type SingleFlightController,
} from "../../src/jobs/transitous/single-flight.js";

function buildStubDb() {
  let counter = 0;
  const stub = {
    select() {
      return {
        from(_table: unknown) {
          return {
            where(_predicate: unknown) {
              return {
                limit(_n: number) {
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(_v: unknown) {
          const id = `job-${++counter}`;
          return {
            returning() {
              return Promise.resolve([{ id }]);
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
  return stub;
}

function makeController(): SingleFlightController {
  return createSingleFlightController({ db: buildStubDb() as never });
}

describe("Overture cron gating", () => {
  let dataDir: string;
  const started: ReturnType<typeof setupCron>[] = [];

  /**
   * `setupCron`, but the handles are also stopped in `afterEach`. croner keys
   * its jobs by name globally, and a test that throws or times out before
   * reaching its own `handles.stop()` leaves that name registered — so every
   * later `setupCron` in this file dies with "name already taken", turning one
   * failure into a cascade of unrelated ones.
   */
  function startCron(options: Parameters<typeof setupCron>[0]): ReturnType<typeof setupCron> {
    const handles = setupCron(options);
    started.push(handles);
    return handles;
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "openmapx-overture-cron-"));
  });

  afterEach(() => {
    for (const handles of started.splice(0)) handles.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("overtureCron is null when overtureEnabled is false (default)", () => {
    const handles = startCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      overtureCronExpression: "0 5 1 * *",
    });
    expect(handles.overtureCron).toBeNull();
    handles.stop();
  });

  it("overtureCron is null when overtureCronExpression is a disable sentinel", () => {
    const handles = startCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      overtureEnabled: true,
      overtureCronExpression: "disabled",
    });
    expect(handles.overtureCron).toBeNull();
    handles.stop();
  });

  it("overtureCron is registered when overtureEnabled=true and valid cron expression", () => {
    const handles = startCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      overtureEnabled: true,
      overtureCronExpression: "0 5 1 * *",
    });
    expect(handles.overtureCron).not.toBeNull();
    handles.stop();
  });

  it("runOvertureNow is always present as a callable function", () => {
    const handles = startCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
    });
    expect(typeof handles.runOvertureNow).toBe("function");
    handles.stop();
  });

  it("runOvertureNow with overtureEnabled=true contains sync failures", async () => {
    let overtureCalled = false;
    const handles = startCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      overtureEnabled: true,
      overtureCronExpression: "0 5 1 * *",
      runStalenessCheck: async () => {},
      runPipeline: async () => {
        overtureCalled = true;
        return { finalStatus: "done", results: [] } as never;
      },
      // Every outbound seam is stubbed so the failure under test is the one we
      // inject. Left to their defaults these reach the live Overture STAC
      // catalogue and then the real regional pull, which is neither a fast nor
      // a deterministic way to observe error containment.
      discoverOvertureRelease: async () => "2026-07-22.0",
      getInstalledOvertureRelease: async () => null,
      syncOvertureRelease: async () => {
        throw new Error("overture sync failed");
      },
    });
    expect(typeof handles.runOvertureNow).toBe("function");
    handles.stop();
    // The cron handler swallows sync errors, so this resolves rather than rejecting.
    await expect(handles.runOvertureNow()).resolves.toBeUndefined();
    void overtureCalled;
  });

  it("discovers and imports a newer release before updating feed state", async () => {
    const calls: string[] = [];
    const handles = startCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      overtureEnabled: true,
      overtureCronExpression: "disabled",
      discoverOvertureRelease: async () => "2026-07-22.0",
      getInstalledOvertureRelease: async () => "2026-06-17.0",
      syncOvertureRelease: async ({ release }) => {
        calls.push(`sync:${release}`);
        return {
          release: release ?? "2026-07-22.0",
          path: "/tmp/region.parquet",
          conflation: "waiting_for_osm",
          linked: 0,
        };
      },
      writeOvertureFeedState: async (_region, release) => {
        calls.push(`state:${release}`);
      },
      runStalenessCheck: async () => {
        calls.push("staleness");
      },
    });

    await handles.runOvertureNow();
    expect(calls).toEqual(["sync:2026-07-22.0", "state:2026-07-22.0", "staleness"]);
    handles.stop();
  });

  it("does not re-import when the latest release is installed but retries links", async () => {
    const syncOvertureRelease = vi.fn();
    const writeOvertureFeedState = vi.fn();
    const rebuildOvertureLinks = vi.fn(async () => ({
      status: "already_completed" as const,
      linked: 17,
    }));
    const handles = startCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      overtureEnabled: true,
      overtureCronExpression: "disabled",
      discoverOvertureRelease: async () => "2026-07-22.0",
      getInstalledOvertureRelease: async () => "2026-07-22.0",
      syncOvertureRelease,
      rebuildOvertureLinks,
      writeOvertureFeedState,
      // An `already_completed` rebuild goes on to finalize the release files.
      // Left to its default that is the real implementation, walking the actual
      // release directories — unrelated to what this test asserts, and slow
      // enough to exhaust the timeout.
      finalizeOvertureReleaseFiles: async () => ({ retained: ["2026-07-22.0"], removed: [] }),
    });

    await handles.runOvertureNow();
    expect(syncOvertureRelease).not.toHaveBeenCalled();
    expect(rebuildOvertureLinks).toHaveBeenCalledWith(
      expect.objectContaining({ release: "2026-07-22.0" }),
    );
    expect(writeOvertureFeedState).not.toHaveBeenCalled();
    handles.stop();
  });

  it("retries conflation without release discovery or Places import", async () => {
    const discoverOvertureRelease = vi.fn(async () => {
      throw new Error("STAC unavailable");
    });
    const syncOvertureRelease = vi.fn();
    const finalizeOvertureReleaseFiles = vi.fn(async () => ({
      retained: ["2026-07-22.0"],
      removed: [],
    }));
    const rebuildOvertureLinks = vi.fn(async () => ({
      status: "completed" as const,
      linked: 23,
      emitted: 32,
      extracted: 30,
      candidates: 25,
      components: 20,
      phaseDurationsMs: {},
    }));
    const handles = startCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      overtureEnabled: true,
      overtureCronExpression: "disabled",
      overtureConflationRetryCronExpression: "disabled",
      discoverOvertureRelease,
      getInstalledOvertureRelease: async () => "2026-07-22.0",
      syncOvertureRelease,
      rebuildOvertureLinks,
      finalizeOvertureReleaseFiles,
    });

    await handles.runOvertureConflationRetryNow();
    expect(rebuildOvertureLinks).toHaveBeenCalledWith(
      expect.objectContaining({ release: "2026-07-22.0" }),
    );
    expect(discoverOvertureRelease).not.toHaveBeenCalled();
    expect(syncOvertureRelease).not.toHaveBeenCalled();
    expect(finalizeOvertureReleaseFiles).toHaveBeenCalledWith(
      expect.objectContaining({ activeRelease: "2026-07-22.0" }),
    );
    handles.stop();
  });

  it("marks Places imported even when the link rebuild reports failure", async () => {
    const calls: string[] = [];
    const handles = startCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      overtureEnabled: true,
      overtureCronExpression: "disabled",
      overtureConflationRetryCronExpression: "disabled",
      discoverOvertureRelease: async () => "2026-07-22.0",
      getInstalledOvertureRelease: async () => "2026-06-17.0",
      syncOvertureRelease: async () => ({
        release: "2026-07-22.0",
        path: "/data/release.parquet",
        conflation: "failed",
        linked: 0,
        conflationError: "temporary failure",
      }),
      writeOvertureFeedState: async () => {
        calls.push("state");
      },
      runStalenessCheck: async () => {
        calls.push("staleness");
      },
    });

    await handles.runOvertureNow();
    expect(calls).toEqual(["state", "staleness"]);
    handles.stop();
  });

  it("does not mark a release imported when the sync fails", async () => {
    const writeOvertureFeedState = vi.fn();
    const handles = startCron({
      dataDir,
      repoRoot: "/tmp/nope",
      countries: [],
      store: {} as never,
      singleFlight: makeController(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      overtureEnabled: true,
      overtureCronExpression: "disabled",
      discoverOvertureRelease: async () => "2026-07-22.0",
      getInstalledOvertureRelease: async () => "2026-06-17.0",
      syncOvertureRelease: async () => {
        throw new Error("import failed");
      },
      writeOvertureFeedState,
    });

    await handles.runOvertureNow();
    expect(writeOvertureFeedState).not.toHaveBeenCalled();
    handles.stop();
  });

  it("overtureCron is registered when OVERTURE_ENABLED env var is 'true'", () => {
    const prev = process.env.OVERTURE_ENABLED;
    try {
      process.env.OVERTURE_ENABLED = "true";
      const handles = startCron({
        dataDir,
        repoRoot: "/tmp/nope",
        countries: [],
        store: {} as never,
        singleFlight: makeController(),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        syncCronExpression: "disabled",
        feedProxyReloadCronExpression: "disabled",
        overtureCronExpression: "0 5 1 * *",
      });
      expect(handles.overtureCron).not.toBeNull();
      handles.stop();
    } finally {
      if (prev === undefined) {
        delete process.env.OVERTURE_ENABLED;
      } else {
        process.env.OVERTURE_ENABLED = prev;
      }
    }
  });
});
