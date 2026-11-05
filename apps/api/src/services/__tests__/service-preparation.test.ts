import { afterAll, beforeEach, expect, it, vi } from "vitest";
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

// Transport-level consumer tests. Real producer/ownership qualification lives
// in configuration-maintenance-postgres.test.ts with the production agent.
const transport = vi.hoisted(() => ({ publish: vi.fn(), execute: vi.fn(), inspect: vi.fn() }));
vi.mock("../trusted-configuration-producer", () => ({
  applyTrustedConfiguration: transport.publish,
}));
vi.mock("../admin-job-ops", async (actual) => ({
  ...(await actual<typeof import("../admin-job-ops")>()),
  executeAdminJobOperation: transport.execute,
}));
vi.mock("../ops-client", async (actual) => ({
  ...(await actual<typeof import("../ops-client")>()),
  createApiOpsClient: () => ({}),
  executeAndWait: transport.inspect,
}));

import { prepareServiceGeneration, updatePreparedService } from "../service-preparation";

const revision = `cfg1_${"a".repeat(43)}`,
  final = `cfg1_${"b".repeat(43)}`;
function context(): JobContext {
  const ctx: JobContext = {
    jobId: "11111111-1111-4111-8111-111111111111",
    payload: {},
    signal: new AbortController().signal,
    checkpointResult: {},
    log: async () => {},
    setProgress: async () => {},
    checkpoint: async (value) => {
      ctx.checkpointResult = value;
    },
  };
  return ctx;
}
beforeEach(() => {
  transport.publish.mockReset().mockResolvedValue({ revisionId: revision });
  transport.inspect.mockReset().mockResolvedValue({ plan: [] });
  transport.execute.mockReset();
});
it("reuses the completed full-generation preparation for the same bulk scope", async () => {
  const ctx = context(),
    result = await prepareServiceGeneration(ctx, "bulk-start", {
      coordinatorMode: "ensure-running",
    });
  expect(result).toEqual({
    revisionId: revision,
    coordinatorMode: "ensure-running",
    hardlinks: { applied: true, entries: 0, linked: 0, skipped: 0, pruned: 0, via: "none" },
  });
  transport.publish.mockRejectedValue(Error("A replay must not publish"));
  transport.inspect.mockRejectedValue(Error("A replay must not inspect another generation"));
  expect(
    await prepareServiceGeneration(ctx, "bulk-start", { coordinatorMode: "ensure-running" }),
  ).toEqual(result);
});
it("refuses a changed coordinator mode on a retained preparation before new transport", async () => {
  const ctx = context();
  await prepareServiceGeneration(ctx, "render", { coordinatorMode: "require-running" });
  transport.publish.mockClear();
  transport.inspect.mockClear();
  await expect(
    prepareServiceGeneration(ctx, "render", { coordinatorMode: "ensure-running" }),
  ).rejects.toThrow();
  expect(transport.publish).not.toHaveBeenCalled();
  expect(transport.inspect).not.toHaveBeenCalled();
});
it("does not publish a completed preparation when the durable hardlink owner is unknown", async () => {
  const ctx = context();
  transport.inspect.mockResolvedValue({ plan: [{ consumerService: "motis" }] });
  transport.execute.mockRejectedValue(Error("Unknown retained hardlink owner"));
  await expect(
    prepareServiceGeneration(ctx, "render", { coordinatorMode: "require-running" }),
  ).rejects.toThrow("Unknown retained");
  expect(ctx.checkpointResult?._servicePreparations).toBeUndefined();
  expect(transport.execute).toHaveBeenCalledExactlyOnceWith(
    ctx,
    {
      kind: "configuration.hardlinks.apply",
      revisionId: revision,
      coordinatorMode: "require-running",
    },
    "admin-job.hardlinks.apply",
    { durableIdentity: `${ctx.jobId}:render` },
  );
});
it("carries the Update target's own final revision and refuses a competing next generation", async () => {
  const ctx = context();
  transport.inspect
    .mockResolvedValueOnce({ revisionId: revision })
    .mockResolvedValueOnce({ revisionId: `cfg1_${"c".repeat(43)}` });
  transport.execute.mockResolvedValue({ changed: true, revisionId: final });
  expect(await updatePreparedService(ctx, "alpha", revision)).toEqual({
    changed: true,
    revisionId: final,
  });
  await expect(updatePreparedService(ctx, "beta", final)).rejects.toThrow("Configuration changed");
  expect(transport.execute).toHaveBeenCalledExactlyOnceWith(
    ctx,
    { kind: "service.update", serviceId: "alpha", expectedConfigurationRevisionId: revision },
    "admin-job.service.update",
    { durableIdentity: "alpha" },
  );
});
