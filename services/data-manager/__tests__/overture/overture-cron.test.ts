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

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "openmapx-overture-cron-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("overtureCron is null when overtureEnabled is false (default)", () => {
    const handles = setupCron({
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
    const handles = setupCron({
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
    const handles = setupCron({
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
    expect(typeof handles.runOvertureNow).toBe("function");
    handles.stop();
  });

  it("runOvertureNow with overtureEnabled=true contains sync failures", async () => {
    let overtureCalled = false;
    const handles = setupCron({
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
    });
    expect(typeof handles.runOvertureNow).toBe("function");
    handles.stop();
    // The real sync will fail (no DuckDB/Postgres), but the cron handler contains errors.
    // but the cron handler swallows errors — assert it resolves without throwing.
    await expect(handles.runOvertureNow()).resolves.toBeUndefined();
    void overtureCalled;
  });

  it("discovers and imports a newer release before updating feed state", async () => {
    const calls: string[] = [];
    const handles = setupCron({
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
    const handles = setupCron({
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
    const rebuildOvertureLinks = vi.fn(async () => ({
      status: "completed" as const,
      linked: 23,
      extracted: 30,
      candidates: 25,
    }));
    const handles = setupCron({
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
    });

    await handles.runOvertureConflationRetryNow();
    expect(rebuildOvertureLinks).toHaveBeenCalledWith(
      expect.objectContaining({ release: "2026-07-22.0" }),
    );
    expect(discoverOvertureRelease).not.toHaveBeenCalled();
    expect(syncOvertureRelease).not.toHaveBeenCalled();
    handles.stop();
  });

  it("marks Places imported even when the link rebuild reports failure", async () => {
    const calls: string[] = [];
    const handles = setupCron({
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
    const handles = setupCron({
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
      const handles = setupCron({
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
