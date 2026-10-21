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
  getStatus: vi.fn(async () => ({ data: {}, status: 200 })),
  link: (...args: unknown[]) => link(...args),
  unwrapDataManagerResponse: (response: unknown) => response,
}));
vi.mock("../service-registry.js", () => ({
  getServiceRegistry: () => ({ get: registryGet }),
}));

const { applyGenerationHardlinks } = await import("../admin-ops.js");

beforeEach(() => {
  vi.clearAllMocks();
  executeAndWait.mockResolvedValue({ revisionId: REVISION, plan });
  dockerComposeAction.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  link.mockResolvedValue({ linked: 1, skipped: 0, pruned: 0 });
  registryGet.mockReturnValue({ enabled: true });
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
