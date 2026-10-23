import { beforeEach, describe, expect, it, vi } from "vitest";

// The module reaches `integration-routes` and therefore Better Auth, which
// asserts on this at import time.
process.env.BETTER_AUTH_SECRET ||= "admin-ops-hardlinks-test-stub-secret";

const REVISION = `cfg1_${"r".repeat(43)}`;
const plan = [
  {
    source: "data/osm",
    target: "data/valhalla/osm-pbf",
    consumerService: "valhalla",
    dataType: "osm-pbf",
  },
];
const executeAndWait = vi.fn();
const dockerComposeAction = vi.fn();
const link = vi.fn();
const getStatus = vi.fn();
const broker = vi.fn();
const registryGet = vi.fn();

vi.mock("../ops-client.js", () => ({
  createApiOpsClient: () => ({}),
  createDurableOpsKey: (scope: string, identity: string) => `${scope}:${identity}`,
  executeAndWait: (...args: unknown[]) => executeAndWait(...args),
}));
vi.mock("../../utils/docker-compose.js", () => ({
  dockerComposeAction: (...args: unknown[]) => dockerComposeAction(...args),
  dockerStatus: vi.fn(),
}));
vi.mock("@openmapx/core/data-manager-sdk", () => ({
  createDataManagerTransport: () => ({}),
  getStatus: (...args: unknown[]) => getStatus(...args),
  link: (...args: unknown[]) => link(...args),
  unwrapDataManagerResponse: (response: unknown) => response,
}));
vi.mock("../service-registry.js", () => ({
  getServiceRegistry: () => ({ get: registryGet }),
}));

vi.mock("../admin-job-ops", () => ({
  executeAdminJobOperation: (...args: unknown[]) => broker(...args),
}));

vi.mock("../trusted-config-operations", () => ({
  applyTrustedConfiguration: async () => ({ revisionId: REVISION }),
}));

const { applyGenerationHardlinks, serviceStart } = await import("../admin-ops.js");

beforeEach(() => {
  vi.clearAllMocks();
  executeAndWait.mockResolvedValue({ revisionId: REVISION, plan });
  dockerComposeAction.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  link.mockResolvedValue({ linked: 1, skipped: 0, pruned: 0 });
  registryGet.mockReturnValue({ enabled: true });
  getStatus.mockResolvedValue({ data: {}, status: 200 });
  broker.mockResolvedValue({ changed: true });
});

describe("applyGenerationHardlinks", () => {
  it("has data-manager apply the plan of the generation just applied", async () => {
    const summary = await applyGenerationHardlinks({
      revisionId: REVISION,
      operationIdentity: "job-1:valhalla",
    });

    // The plan comes from the operations agent, for exactly this generation.
    expect(executeAndWait).toHaveBeenCalledWith(
      expect.anything(),
      { kind: "configuration.hardlinks.inspect", revisionId: REVISION },
      "admin-job.hardlinks.inspect:job-1:valhalla",
      expect.anything(),
    );
    // Data-manager, whose mounts confine it to the data root, applies it.
    expect(dockerComposeAction).toHaveBeenCalledWith("data-manager", "start", expect.anything());
    expect(link).toHaveBeenCalledWith({ plan, prune: true }, expect.anything());
    expect(summary).toMatchObject({ applied: true, entries: 1, linked: 1 });
  });

  it("does nothing more for an empty plan", async () => {
    executeAndWait.mockResolvedValue({ revisionId: REVISION, plan: [] });
    await expect(
      applyGenerationHardlinks({ revisionId: REVISION, operationIdentity: "job-2" }),
    ).resolves.toEqual({ applied: true, linked: 0, skipped: 0, pruned: 0, entries: 0 });
    expect(dockerComposeAction).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
  });

  it("refuses a non-empty plan while data-manager is disabled", async () => {
    registryGet.mockReturnValue({ enabled: false });
    await expect(
      applyGenerationHardlinks({ revisionId: REVISION, operationIdentity: "job-3" }),
    ).rejects.toThrow('service "data-manager" is disabled');
    expect(link).not.toHaveBeenCalled();
  });
});

it("does not link or start a later lifecycle effect after canceled readiness resolves", async () => {
  const ready = Promise.withResolvers<unknown>();
  getStatus.mockReturnValue(ready.promise);
  const abort = new AbortController();
  const ctx = {
    jobId: "fix1-service",
    payload: {},
    signal: abort.signal,
    log: vi.fn(),
    setProgress: vi.fn(),
    checkpoint: vi.fn(),
    checkpointResult: {},
  };
  const work = serviceStart("valhalla", ctx);
  const outcome = work.then(
    () => "fulfilled",
    (error) => error,
  );
  await vi.waitFor(() => expect(getStatus).toHaveBeenCalled());
  abort.abort();
  ready.resolve({ data: {}, status: 200 });
  expect(await outcome).toBeInstanceOf(Error);
  expect(link).not.toHaveBeenCalled();
  expect(broker.mock.calls.map((call) => call[1])).toEqual([
    { kind: "service.start", serviceId: "data-manager" },
  ]);
});

it("fences the link attempt against current ownership after readiness", async () => {
  const { JobOwnershipLost } = await import("../admin-job-state");
  const ctx = {
    jobId: "fix1-owner",
    payload: {},
    signal: new AbortController().signal,
    log: vi.fn(),
    setProgress: vi.fn(),
    checkpoint: vi.fn().mockRejectedValue(new JobOwnershipLost()),
    checkpointResult: {},
  };
  await expect(
    applyGenerationHardlinks({
      revisionId: REVISION,
      operationIdentity: "fix1-owner:valhalla",
      ctx,
    }),
  ).rejects.toBeInstanceOf(JobOwnershipLost);
  expect(link).not.toHaveBeenCalled();
});

it("retains an unknown link attempt and refuses any coordinator/link replay", async () => {
  const { JobObservationPending } = await import("../admin-job-failure");
  const ctx: import("../job-runner").JobContext = {
    jobId: "fix1-link",
    payload: {},
    signal: new AbortController().signal,
    log: vi.fn(),
    setProgress: vi.fn(),
    checkpoint: async (value) => {
      ctx.checkpointResult = structuredClone(value);
    },
    checkpointResult: {},
  };
  link.mockImplementation(async () => {
    expect(ctx.checkpointResult).toMatchObject({
      _hardlinkAttempts: { "fix1-link:valhalla": { revisionId: REVISION, phase: "attempted" } },
    });
    throw new Error("response lost after remote acceptance");
  });
  const options = { revisionId: REVISION, operationIdentity: "fix1-link:valhalla", ctx };
  await expect(applyGenerationHardlinks(options)).rejects.toBeInstanceOf(JobObservationPending);
  await expect(applyGenerationHardlinks(options)).rejects.toBeInstanceOf(JobObservationPending);
  expect(link).toHaveBeenCalledTimes(1);
  expect(broker).toHaveBeenCalledTimes(1);
});
