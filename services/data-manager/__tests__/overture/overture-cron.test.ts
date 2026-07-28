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
          conflation: "skipped",
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

  it("does not re-import or refresh state when the latest release is installed", async () => {
    const syncOvertureRelease = vi.fn();
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
      getInstalledOvertureRelease: async () => "2026-07-22.0",
      syncOvertureRelease,
      writeOvertureFeedState,
    });

    await handles.runOvertureNow();
    expect(syncOvertureRelease).not.toHaveBeenCalled();
    expect(writeOvertureFeedState).not.toHaveBeenCalled();
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
