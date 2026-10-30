import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminJobFailure, JobObservationPending } from "../admin-job-failure";
import type { JobContext } from "../job-runner";

const mocks = vi.hoisted(() => ({ run: vi.fn(), inspect: vi.fn() }));
vi.mock("../retained-maintenance-authorization", () => ({ assertRetainedMaintenanceJob: vi.fn() }));
vi.mock("../admin-job-ops", () => ({ executeAdminJobOperation: mocks.run }));
vi.mock("../admin-operation-input", () => ({ assertKnownServiceIds: vi.fn() }));
vi.mock("../administrative-configuration-writer", () => ({
  withAdministrativeConfigurationJob: (_ctx: unknown, run: () => unknown) => run(),
  withAdministrativeConfigurationWriter: (_options: unknown, run: () => unknown) => run(),
}));
vi.mock("../ops-client", async (original) => ({
  ...(await original<typeof import("../ops-client")>()),
  createApiOpsClient: () => ({}),
  executeAndWait: mocks.inspect,
}));
const { handleImageStageJob } = await import("../admin-image-staging");
const revision = `cfg1_${"a".repeat(43)}`;
function context() {
  const ctx = {
    jobId: "c23eca24-e686-4552-8f43-139d44b9e859",
    payload: { serviceIds: ["motis", "data-manager", "ops-agent"] },
    signal: new AbortController().signal,
    checkpointResult: {} as Record<string, unknown>,
    checkpoint: vi.fn(async (value: Record<string, unknown>) => {
      ctx.checkpointResult = value;
    }),
  };
  return ctx as unknown as JobContext;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspect.mockResolvedValue({ revisionId: revision });
  mocks.run.mockResolvedValue({ revisionId: revision });
});
describe("retained image-stage batches", () => {
  it("retains the initial revision before effects and observes the same step addresses on recovery", async () => {
    const ctx = context();
    await handleImageStageJob(ctx);
    expect(ctx.checkpointResult?._imageStageRevisionId).toBe(revision);
    expect(mocks.run.mock.calls.map((call) => [call[1], call[3]])).toEqual(
      ["motis", "data-manager", "ops-agent"].map((serviceId, index) => [
        { kind: "service.image.stage", serviceId, expectedConfigurationRevisionId: revision },
        { durableIdentity: `${index}:${serviceId}` },
      ]),
    );
    const addresses = mocks.run.mock.calls.map((call) => call.slice(1));
    mocks.run.mockClear();
    await handleImageStageJob(ctx);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls.map((call) => call.slice(1))).toEqual(addresses);
  });
  it("retains a completed prefix and stops a settled failure without replaying the failed batch", async () => {
    const ctx = context();
    mocks.run
      .mockResolvedValueOnce({ revisionId: revision })
      .mockRejectedValueOnce(new Error("failed"));
    await expect(handleImageStageJob(ctx)).rejects.toBeInstanceOf(AdminJobFailure);
    expect(ctx.checkpointResult?.serviceBatch).toEqual({
      outcome: "partial",
      completedServiceIds: ["motis"],
      failedServiceIds: ["data-manager"],
      skippedServiceIds: ["ops-agent"],
    });
    await expect(handleImageStageJob(ctx)).rejects.toBeInstanceOf(AdminJobFailure);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it("preserves pending observation without labeling the unresolved service failed", async () => {
    const ctx = context(),
      pending = new JobObservationPending("transport");
    mocks.run.mockResolvedValueOnce({ revisionId: revision }).mockRejectedValueOnce(pending);
    await expect(handleImageStageJob(ctx)).rejects.toBe(pending);
    expect(ctx.checkpointResult?.serviceBatch).toEqual({
      outcome: "partial",
      completedServiceIds: ["motis"],
      failedServiceIds: [],
      skippedServiceIds: ["ops-agent"],
    });
  });
});
