import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner.js";

// The authority module reaches `integration-routes` and therefore Better Auth,
// which asserts on this at import time.
process.env.BETTER_AUTH_SECRET ||= "admin-ops-authority-test-stub-secret";

const dockerComposeAction = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
const registryGet = vi.fn();

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
    registryGet.mockReturnValue({ manifest: { id: "redis" }, enabled: true, isBuiltIn: true });
    await serviceStop("redis", context());
    expect(dockerComposeAction).toHaveBeenCalledWith(
      "redis",
      "stop",
      expect.objectContaining({
        operationKey: expect.stringMatching(/^opk1_/),
        signal: expect.anything(),
      }),
    );
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
    expect(dockerComposeAction).toHaveBeenCalledWith(
      "community-weather",
      "restart",
      expect.objectContaining({ signal: ctx.signal }),
    );
  });

  it("denies disabled services before either authority boundary", async () => {
    registryGet.mockReturnValue({
      manifest: { id: "community-weather" },
      enabled: false,
      isBuiltIn: false,
    });
    await expect(serviceStop("community-weather", context())).rejects.toThrow("is disabled");
    expect(dockerComposeAction).not.toHaveBeenCalled();
  });
});
