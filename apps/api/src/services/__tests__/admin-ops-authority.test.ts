import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner.js";

// The authority module reaches `integration-routes` and therefore Better Auth,
// which asserts on this at import time.
process.env.BETTER_AUTH_SECRET ||= "admin-ops-authority-test-stub-secret";

const executeAdminJobOperation = vi.fn();
const dockerComposeAction = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
const applyTrustedConfiguration = vi.fn();
const executeAndWait = vi.fn();
const registryGet = vi.fn();

vi.mock("../admin-job-ops.js", () => ({
  executeAdminJobOperation: (...args: unknown[]) => executeAdminJobOperation(...args),
}));
vi.mock("../../utils/docker-compose.js", () => ({
  dockerComposeAction: (...args: unknown[]) => dockerComposeAction(...args),
  dockerStatus: vi.fn(),
}));
vi.mock("../trusted-config-operations.js", () => ({
  applyTrustedConfiguration: (...args: unknown[]) => applyTrustedConfiguration(...args),
}));
vi.mock("../ops-client.js", async (importActual) => ({
  ...(await importActual<typeof import("../ops-client.js")>()),
  createApiOpsClient: () => ({}),
  executeAndWait: (...args: unknown[]) => executeAndWait(...args),
}));
vi.mock("../service-registry.js", () => ({
  getServiceRegistry: () => ({ get: registryGet }),
}));

let serviceApply: typeof import("../admin-ops.js").serviceApply;
let serviceRestart: typeof import("../admin-ops.js").serviceRestart;
let serviceStart: typeof import("../admin-ops.js").serviceStart;
let serviceStop: typeof import("../admin-ops.js").serviceStop;

beforeAll(async () => {
  ({ serviceApply, serviceRestart, serviceStart, serviceStop } = await import("../admin-ops.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  executeAdminJobOperation.mockResolvedValue({ changed: true });
  dockerComposeAction.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  applyTrustedConfiguration.mockResolvedValue({ revisionId: `cfg1_${"r".repeat(43)}` });
  executeAndWait.mockResolvedValue({ plan: [] });
});

function context(): JobContext {
  return {
    jobId: "job-123",
    payload: {},
    signal: new AbortController().signal,
    log: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    checkpoint: vi.fn().mockResolvedValue(undefined),
  };
}

describe("admin service authority split", () => {
  it("keeps enabled built-ins on typed ops-agent lifecycle", async () => {
    registryGet.mockReturnValue({ manifest: { id: "redis" }, enabled: true, isBuiltIn: true });
    const ctx = context();
    await serviceStop("redis", ctx);
    expect(executeAdminJobOperation).toHaveBeenCalledWith(
      ctx,
      { kind: "service.stop", serviceId: "redis" },
      "admin-job.service.stop",
      { durableIdentity: "redis" },
    );
    expect(dockerComposeAction).not.toHaveBeenCalled();
  });

  it("routes enabled community lifecycle through the same typed operation", async () => {
    registryGet.mockReturnValue({
      manifest: { id: "community-weather" },
      enabled: true,
      isBuiltIn: false,
    });
    const ctx = context();
    await serviceRestart("community-weather", ctx);
    // No direct-Docker adapter remains: the agent authorizes the community id
    // against its own trusted selection.
    expect(executeAdminJobOperation).toHaveBeenCalledWith(
      ctx,
      { kind: "service.restart", serviceId: "community-weather" },
      "admin-job.service.restart",
      { durableIdentity: "community-weather" },
    );
  });

  it("denies disabled services before either authority boundary", async () => {
    registryGet.mockReturnValue({
      manifest: { id: "community-weather" },
      enabled: false,
      isBuiltIn: false,
    });
    await expect(serviceStop("community-weather", context())).rejects.toThrow("is disabled");
    expect(executeAdminJobOperation).not.toHaveBeenCalled();
    expect(dockerComposeAction).not.toHaveBeenCalled();
  });

  it("denies unknown services before any operation is submitted", async () => {
    registryGet.mockReturnValue(undefined);
    await expect(serviceRestart("ghost", context())).rejects.toThrow("Unknown service");
    expect(executeAdminJobOperation).not.toHaveBeenCalled();
    expect(dockerComposeAction).not.toHaveBeenCalled();
  });

  it("maps all four lifecycle effects onto their typed kinds under the legacy namespaces", async () => {
    registryGet.mockReturnValue({ manifest: { id: "redis" }, enabled: true, isBuiltIn: true });
    const cases = [
      { run: serviceStart, kind: "service.start", namespace: "admin-job.service.start" },
      { run: serviceApply, kind: "service.recreate", namespace: "admin-job.service.recreate" },
      { run: serviceStop, kind: "service.stop", namespace: "admin-job.service.stop" },
      { run: serviceRestart, kind: "service.restart", namespace: "admin-job.service.restart" },
    ] as const;
    for (const { run, kind, namespace } of cases) {
      executeAdminJobOperation.mockClear();
      const ctx = context();
      await run("redis", ctx);
      expect(executeAdminJobOperation).toHaveBeenCalledOnce();
      expect(executeAdminJobOperation).toHaveBeenCalledWith(
        ctx,
        { kind, serviceId: "redis" },
        namespace,
        { durableIdentity: "redis" },
      );
    }
  });

  it("keeps start and apply phases ordered ahead of the lifecycle effect", async () => {
    registryGet.mockReturnValue({ manifest: { id: "redis" }, enabled: true, isBuiltIn: true });
    const order: string[] = [];
    applyTrustedConfiguration.mockImplementation(async () => {
      order.push("configuration");
      return { revisionId: `cfg1_${"r".repeat(43)}` };
    });
    executeAndWait.mockImplementation(async () => {
      order.push("hardlinks");
      return { plan: [] };
    });
    executeAdminJobOperation.mockImplementation(async (_ctx, operation) => {
      order.push(operation.kind);
      return { changed: true };
    });

    await serviceStart("redis", context());
    await serviceApply("redis", context());

    expect(order).toEqual([
      "configuration",
      "hardlinks",
      "service.start",
      "configuration",
      "hardlinks",
      "service.recreate",
    ]);
  });

  it.each([
    { run: () => serviceStop, label: "stop", failure: "docker compose stop exited with 1" },
    {
      run: () => serviceRestart,
      label: "restart",
      failure: "docker compose restart exited with 1",
    },
    { run: () => serviceStart, label: "start", failure: "docker compose up exited with 1" },
    {
      run: () => serviceApply,
      label: "apply",
      failure: "docker compose up --force-recreate exited with 1",
    },
  ])(
    "keeps the legacy $label failure wording and logs no success when the agent fails",
    async ({ run, failure }) => {
      registryGet.mockReturnValue({ manifest: { id: "redis" }, enabled: true, isBuiltIn: true });
      executeAdminJobOperation.mockRejectedValue(new Error("raw agent detail"));
      const ctx = context();

      const error = await run()("redis", ctx).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toEqual(new Error(failure));
      expect((error as Error).message).not.toContain("raw agent detail");
      expect(ctx.log).not.toHaveBeenCalledWith(
        expect.stringMatching(/ (started|stopped|restarted)\.$/),
      );
      expect(ctx.log).not.toHaveBeenCalledWith(expect.stringContaining("configuration applied"));
    },
  );
});
