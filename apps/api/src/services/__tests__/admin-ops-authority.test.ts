import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner.js";

// The authority module reaches `integration-routes` and therefore Better Auth,
// which asserts on this at import time.
process.env.BETTER_AUTH_SECRET ||= "admin-ops-authority-test-stub-secret";

const dockerComposeAction = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
const registryGet = vi.fn();
const executeAdminJobOperation = vi.fn().mockResolvedValue({ changed: true });
vi.mock("../admin-job-ops", () => ({
  executeAdminJobOperation: (...args: unknown[]) => executeAdminJobOperation(...args),
}));

vi.mock("../../utils/docker-compose.js", () => ({
  dockerComposeAction: (...args: unknown[]) => dockerComposeAction(...args),
  dockerStatus: vi.fn(),
}));
vi.mock("../service-registry.js", () => ({
  getServiceRegistry: () => ({ get: registryGet }),
}));

let serviceRestart: typeof import("../admin-ops.js").serviceRestart;
let serviceStop: typeof import("../admin-ops.js").serviceStop;

beforeAll(async () => {
  ({ serviceRestart, serviceStop } = await import("../admin-ops.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  dockerComposeAction.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
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
    registryGet.mockReturnValue({ manifest: { id: "motis" }, enabled: true, isBuiltIn: true });
    await serviceStop("motis", context());
    expect(executeAdminJobOperation).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-123" }),
      { kind: "service.stop", serviceId: "motis" },
      "admin-job.service.stop",
      { durableIdentity: "motis" },
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
    expect(ctx.checkpoint).toHaveBeenCalledBefore(executeAdminJobOperation);
    expect(dockerComposeAction).not.toHaveBeenCalled();
  });

  it("passes disabled known-service Stop to agent ownership policy but still denies Restart", async () => {
    registryGet.mockReturnValue({
      manifest: { id: "community-weather" },
      enabled: false,
      isBuiltIn: false,
    });
    await serviceStop("community-weather", context());
    expect(executeAdminJobOperation).toHaveBeenCalledWith(
      expect.anything(),
      { kind: "service.stop", serviceId: "community-weather" },
      "admin-job.service.stop",
      { durableIdentity: "community-weather" },
    );
    executeAdminJobOperation.mockClear();
    await expect(serviceRestart("community-weather", context())).rejects.toThrow("is disabled");
    expect(dockerComposeAction).not.toHaveBeenCalled();
    expect(executeAdminJobOperation).not.toHaveBeenCalled();
  });
});
