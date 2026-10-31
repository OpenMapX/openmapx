import { randomUUID } from "node:crypto";
import type { CoordinatorMode } from "@openmapx/core/ops";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JobObservationPending } from "../admin-job-failure";
import type { JobContext } from "../job-runner";

const previousAuthSecret = vi.hoisted(() => {
  const previous = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET ??= "task012-unit-only-synthetic-auth-secret";
  return { previous };
});
afterAll(() => {
  if (previousAuthSecret.previous === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = previousAuthSecret.previous;
});

const REVISION = `cfg1_${"r".repeat(43)}`;
const plan = [
  {
    source: "data/osm",
    target: "data/valhalla/osm-pbf",
    consumerService: "valhalla",
    dataType: "osm-pbf",
  },
];
const summary = {
  applied: true,
  entries: 1,
  linked: 1,
  skipped: 0,
  pruned: 0,
  via: "data-manager",
};
// These are typed transport/publication boundary tests. The separate owned-PG
// suites qualify the actual agent, role authority and durable DM leaf.
const inspect = vi.fn(),
  broker = vi.fn(),
  publish = vi.fn();
vi.mock("../ops-client", async (original) => ({
  ...(await original<typeof import("../ops-client")>()),
  createApiOpsClient: () => ({}),
  executeAndWait: (...args: unknown[]) => inspect(...args),
}));
vi.mock("../admin-job-ops", () => ({
  executeAdminJobOperation: (...args: unknown[]) => broker(...args),
}));
vi.mock("../trusted-config-operations", () => ({
  applyTrustedConfiguration: (...args: unknown[]) => publish(...args),
}));
vi.mock("../trusted-configuration-producer", () => ({
  applyTrustedConfiguration: (...args: unknown[]) => publish(...args),
}));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => ({ get: () => ({ enabled: true }) }),
}));
const { applyGenerationHardlinks, serviceStart } = await import("../admin-ops");
function context(): JobContext {
  const ctx: JobContext = {
    jobId: randomUUID(),
    execution: { owner: randomUUID(), version: 1 },
    payload: {},
    signal: new AbortController().signal,
    log: async () => {},
    setProgress: async () => {},
    checkpointResult: {},
    checkpoint: async (value) => {
      ctx.checkpointResult = structuredClone(value);
    },
  };
  return ctx;
}
beforeEach(() => {
  inspect.mockReset().mockResolvedValue({ revisionId: REVISION, plan });
  publish.mockReset().mockResolvedValue({ revisionId: REVISION });
  broker
    .mockReset()
    .mockImplementation(async (_ctx, operation) =>
      operation.kind === "configuration.hardlinks.apply" ? summary : { changed: true },
    );
});
describe("retained generation hardlinks", () => {
  it("settles a separate revision-checked coordinator Start before the typed middle owner", async () => {
    const ctx = context();
    expect(
      await applyGenerationHardlinks({
        ctx,
        revisionId: REVISION,
        operationIdentity: "job:valhalla",
        coordinatorMode: "ensure-running",
      }),
    ).toEqual(summary);
    expect(inspect.mock.calls[0]![1]).toEqual({
      kind: "configuration.hardlinks.inspect",
      revisionId: REVISION,
    });
    expect(broker.mock.calls.map((call) => call[1])).toEqual([
      {
        kind: "service.start",
        serviceId: "data-manager",
        expectedConfigurationRevisionId: REVISION,
      },
      {
        kind: "configuration.hardlinks.apply",
        revisionId: REVISION,
        coordinatorMode: "ensure-running",
      },
    ]);
  });
  it("require-running delegates only the exact conditioned hardlink operation", async () => {
    const ctx = context();
    await applyGenerationHardlinks({
      ctx,
      revisionId: REVISION,
      operationIdentity: "render",
      coordinatorMode: "require-running",
    });
    expect(broker.mock.calls.map((call) => call[1])).toEqual([
      {
        kind: "configuration.hardlinks.apply",
        revisionId: REVISION,
        coordinatorMode: "require-running",
      },
    ]);
  });
  it.each(["ensure-running", "require-running"] as CoordinatorMode[])(
    "needs no coordinator for an empty plan in %s",
    async (coordinatorMode) => {
      inspect.mockResolvedValue({ revisionId: REVISION, plan: [] });
      expect(
        await applyGenerationHardlinks({
          ctx: context(),
          revisionId: REVISION,
          operationIdentity: "empty",
          coordinatorMode,
        }),
      ).toEqual({ applied: true, entries: 0, linked: 0, skipped: 0, pruned: 0, via: "none" });
      expect(broker).not.toHaveBeenCalled();
    },
  );
  it("does not admit hardlinks after coordinator Start fails", async () => {
    broker.mockRejectedValueOnce(Error("Synthetic coordinator failure"));
    await expect(
      applyGenerationHardlinks({
        ctx: context(),
        revisionId: REVISION,
        operationIdentity: "failed",
        coordinatorMode: "ensure-running",
      }),
    ).rejects.toThrow();
    expect(broker).toHaveBeenCalledTimes(1);
  });
  it("keeps an unknown durable leaf pending", async () => {
    broker.mockRejectedValueOnce(new JobObservationPending("recovery_required"));
    await expect(
      applyGenerationHardlinks({
        ctx: context(),
        revisionId: REVISION,
        operationIdentity: "unknown",
        coordinatorMode: "require-running",
      }),
    ).rejects.toBeInstanceOf(JobObservationPending);
    expect(broker).toHaveBeenCalledTimes(1);
  });
  it("rejects a call without a retained job before host inspection", async () => {
    await expect(
      applyGenerationHardlinks({
        revisionId: REVISION,
        operationIdentity: "foreign",
        coordinatorMode: "ensure-running",
      }),
    ).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
  });
  it("observes an old unknown link attempt without another coordinator or leaf call", async () => {
    const ctx = context();
    ctx.checkpointResult = {
      _hardlinkAttempts: { retained: { revisionId: REVISION, phase: "attempted" } },
    };
    const options = {
      ctx,
      revisionId: REVISION,
      operationIdentity: "retained",
      coordinatorMode: "ensure-running" as const,
    };
    await expect(applyGenerationHardlinks(options)).rejects.toBeInstanceOf(JobObservationPending);
    await expect(applyGenerationHardlinks(options)).rejects.toBeInstanceOf(JobObservationPending);
    expect(inspect).not.toHaveBeenCalled();
    expect(broker).not.toHaveBeenCalled();
  });
  it("returns only the exact completed legacy link receipt", async () => {
    const ctx = context();
    ctx.checkpointResult = {
      _hardlinkAttempts: { retained: { revisionId: REVISION, phase: "complete", result: summary } },
    };
    expect(
      await applyGenerationHardlinks({
        ctx,
        revisionId: REVISION,
        operationIdentity: "retained",
        coordinatorMode: "require-running",
      }),
    ).toEqual(summary);
    expect(inspect).not.toHaveBeenCalled();
  });
  it("single Start uses shared full preparation and targets only its final revision", async () => {
    const ctx = context();
    await serviceStart("valhalla", ctx);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      kind: "stack.render",
      coordinatorMode: "ensure-running",
    });
    expect(broker.mock.calls.map((call) => call[1])).toEqual([
      {
        kind: "service.start",
        serviceId: "data-manager",
        expectedConfigurationRevisionId: REVISION,
      },
      {
        kind: "configuration.hardlinks.apply",
        revisionId: REVISION,
        coordinatorMode: "ensure-running",
      },
      { kind: "service.start", serviceId: "valhalla", expectedConfigurationRevisionId: REVISION },
    ]);
    const published = broker.mock.calls.length;
    await (await import("../service-preparation")).prepareServiceGeneration(ctx, "start:valhalla", {
      coordinatorMode: "ensure-running",
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(broker).toHaveBeenCalledTimes(published);
  });
  it("single Start does not reach its target after preparation fails", async () => {
    broker.mockRejectedValueOnce(Error("Synthetic helper failure"));
    await expect(serviceStart("valhalla", context())).rejects.toThrow();
    expect(broker).toHaveBeenCalledTimes(1);
  });
});
