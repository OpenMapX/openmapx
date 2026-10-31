import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CronSetupOptions, setupCron } from "../../src/cron.js";
import { createSingleFlightController } from "../../src/jobs/transitous/single-flight.js";
import { dataReceipt, receiverFixture } from "../helpers/execution-receiver.js";

describe("Overture cron durable ownership", () => {
  let dataDir: string;
  const started: ReturnType<typeof setupCron>[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  function start(extra: Partial<CronSetupOptions> = {}) {
    // This collaborator is never used to start data work: the receiver owns it.
    const singleFlight = createSingleFlightController({ db: {} as never });
    const handles = setupCron({
      dataDir,
      countries: [],
      store: {} as never,
      singleFlight,
      logger,
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      stalenessCheckCronExpression: "disabled",
      trafficExtractCronExpression: "disabled",
      trafficLiveCronExpression: "disabled",
      trafficPredictedCronExpression: "disabled",
      overtureCronExpression: "disabled",
      overtureConflationRetryCronExpression: "disabled",
      executionReceiver: receiverFixture(),
      discoverOvertureRelease: async () => "2026-07-22.0",
      getInstalledOvertureRelease: async () => "2026-06-17.0",
      runStalenessCheck: async () => {},
      githubIssueSink: null,
      ...extra,
    });
    started.push(handles);
    return handles;
  }
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "omx-overture-owned-cron-"));
    vi.clearAllMocks();
  });
  afterEach(() => {
    for (const h of started.splice(0)) h.stop();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it("leaves both schedules off when disabled", () => {
    const h = start({ overtureEnabled: false });
    expect(h.overtureCron).toBeNull();
    expect(h.overtureConflationRetryCron).toBeNull();
  });
  it("honors schedule disable sentinels", () => {
    const h = start({ overtureEnabled: true });
    expect(h.overtureCron).toBeNull();
  });
  it("registers the enabled release schedule", () => {
    expect(
      start({ overtureEnabled: true, overtureCronExpression: "0 5 1 * *" }).overtureCron,
    ).not.toBeNull();
  });
  it("registers the enabled independent retry", () => {
    expect(
      start({ overtureEnabled: true, overtureConflationRetryCronExpression: "*/15 * * * *" })
        .overtureConflationRetryCron,
    ).not.toBeNull();
  });
  it("uses the environment opt-in", () => {
    vi.stubEnv("OVERTURE_ENABLED", "true");
    expect(start({ overtureCronExpression: "0 5 1 * *" }).overtureCron).not.toBeNull();
  });
  it("admits the actual typed sync once with the cron actor and observes its original identity", async () => {
    const admitted = dataReceipt({ status: "running", publication: "unknown" }),
      admitLocal = vi.fn(async () => admitted),
      inspect = vi.fn(async () => dataReceipt()),
      staleness = vi.fn(async () => {}),
      cancel = vi.fn();
    const h = start({
      executionReceiver: receiverFixture({ admitLocal, inspect, requestCancel: cancel }),
      runStalenessCheck: staleness,
    });
    await h.runOvertureNow();
    expect(admitLocal).toHaveBeenCalledExactlyOnceWith(
      { kind: "overture-sync", region: "europe/germany/berlin" },
      { triggeredBy: "cron" },
    );
    expect(inspect).toHaveBeenCalledExactlyOnceWith(admitted.id);
    expect(staleness).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
  it("keeps partial Places publication visible while the independent link stage is incomplete", async () => {
    const staleness = vi.fn(async () => {});
    const h = start({
      executionReceiver: receiverFixture({
        admitLocal: async () =>
          dataReceipt({
            status: "partial",
            result: {
              kind: "overture-sync",
              region: "europe/germany/berlin",
              release: "2026-07-22.0",
              metrics: { processed: 0 },
            },
          }),
      }),
      runStalenessCheck: staleness,
    });
    await h.runOvertureNow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("link rebuild remains incomplete"),
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    expect(staleness).toHaveBeenCalledOnce();
  });
  it("does not re-import an installed release, and delegates link retry to its own durable worker", async () => {
    const admitLocal = vi.fn(async () => dataReceipt({ kind: "overture-conflate" }));
    const h = start({
      getInstalledOvertureRelease: async () => "2026-07-22.0",
      executionReceiver: receiverFixture({ admitLocal }),
    });
    await h.runOvertureNow();
    expect(admitLocal).toHaveBeenCalledExactlyOnceWith(
      { kind: "overture-conflate", region: "europe/germany/berlin" },
      { triggeredBy: "cron" },
    );
  });
  it("does not downgrade an installed newer release", async () => {
    const admitLocal = vi.fn(async () => dataReceipt({ kind: "overture-conflate" }));
    const h = start({
      getInstalledOvertureRelease: async () => "2026-08-19.0",
      executionReceiver: receiverFixture({ admitLocal }),
    });
    await h.runOvertureNow();
    expect(admitLocal).toHaveBeenCalledExactlyOnceWith(
      { kind: "overture-conflate", region: "europe/germany/berlin" },
      { triggeredBy: "cron" },
    );
  });
  it("retries links without catalogue discovery or a Places import", async () => {
    const discover = vi.fn(async () => {
        throw Error("STAC unavailable");
      }),
      admitLocal = vi.fn(async () => dataReceipt({ kind: "overture-conflate" }));
    const h = start({
      discoverOvertureRelease: discover,
      executionReceiver: receiverFixture({ admitLocal }),
    });
    await h.runOvertureConflationRetryNow();
    expect(discover).not.toHaveBeenCalled();
    expect(admitLocal).toHaveBeenCalledExactlyOnceWith(
      { kind: "overture-conflate", region: "europe/germany/berlin" },
      { triggeredBy: "cron" },
    );
  });
  it("skips link retry without an installed release", async () => {
    const admitLocal = vi.fn();
    await start({
      getInstalledOvertureRelease: async () => null,
      executionReceiver: receiverFixture({ admitLocal }),
    }).runOvertureConflationRetryNow();
    expect(admitLocal).not.toHaveBeenCalled();
  });
  it("contains failed or unavailable admission without publication or a success check", async () => {
    const staleness = vi.fn(async () => {}),
      admitLocal = vi.fn(async () => {
        throw Error("configuration_maintenance_busy");
      });
    const h = start({
      executionReceiver: receiverFixture({ admitLocal }),
      runStalenessCheck: staleness,
    });
    await expect(h.runOvertureNow()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    expect(staleness).not.toHaveBeenCalled();
    await expect(start({ executionReceiver: undefined }).runOvertureNow()).resolves.toBeUndefined();
  });
});
