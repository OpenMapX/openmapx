import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
                orderBy() {
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
});
