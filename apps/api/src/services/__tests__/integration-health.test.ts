import type { LoadedIntegration } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock service-registry before importing the module under test
vi.mock("../service-registry", () => ({
  serviceUrl: (id: string) => {
    if (id === "valhalla") return "http://valhalla:8002";
    return undefined;
  },
}));

// Mock health-history to avoid DB side effects
vi.mock("../health-history", () => ({
  recordHealthResult: vi.fn().mockResolvedValue(undefined),
}));

import { executeIntegrationHealthCheck } from "../integration-health";

function makeIntegration(hc: unknown): LoadedIntegration {
  return {
    id: "test-integration",
    manifest: {
      name: "Test Integration",
      domains: ["Other"] as [string, ...string[]],
      healthCheck: hc,
    },
    config: {},
    directory: "",
    isBuiltIn: false,
    enabled: true,
    providers: new Map(),
    strings: { en: { name: "Test Integration" } },
    shutdownHandlers: [],
  } as unknown as LoadedIntegration;
}

describe("integration-health SSRF guard", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("case 1: blocks HTTP request to AWS metadata endpoint (169.254.x.x)", async () => {
    const integration = makeIntegration({
      type: "http",
      url: "http://169.254.169.254/latest/meta-data/",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("down");
    expect(results[0]?.error).toMatch(/not allowed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("case 2: blocks HTTP request to loopback address (127.0.0.1)", async () => {
    const integration = makeIntegration({
      type: "http",
      url: "http://127.0.0.1:6379",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("down");
    expect(results[0]?.error).toMatch(/not allowed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("case 3: allows HTTP request to public host", async () => {
    const integration = makeIntegration({
      type: "http",
      url: "https://api.example.com/health",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("up");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.example.com/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("case 4: allows service:-resolved internal host (no false-positive)", async () => {
    const integration = makeIntegration({
      type: "http",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional string (manifest template syntax, not JS interpolation)
      urlTemplate: "${service:valhalla}/health",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("up");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://valhalla:8002/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("case 5: blocks smuggling attack (IP-literal plus service: placeholder)", async () => {
    // The template resolves to http://169.254.169.254/x#... (fragment doesn't change host),
    // but the final host (169.254.169.254) is NOT in serviceHosts (only valhalla:8002 is),
    // so the guard must reject it.
    const integration = makeIntegration({
      type: "http",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional string (manifest template syntax, not JS interpolation)
      urlTemplate: "http://169.254.169.254/x#${service:valhalla}",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("down");
    expect(results[0]?.error).toMatch(/not allowed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("case 6: blocks TCP probe to IP-literal private host", async () => {
    const integration = makeIntegration({
      type: "tcp",
      url: "169.254.169.254:80",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("down");
    expect(results[0]?.error).toMatch(/not allowed/i);
    // fetch should not be called for TCP checks
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
