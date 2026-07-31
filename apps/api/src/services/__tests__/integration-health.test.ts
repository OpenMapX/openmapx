import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// Mock the browser-fingerprint client so tests never load the native `impit`
// module or hit the network.
vi.mock("@openmapx/integration-framework/impersonate", () => ({
  impersonatingFetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
}));

import { impersonatingFetch } from "@openmapx/integration-framework/impersonate";
import {
  executeAllIntegrationHealthChecks,
  executeIntegrationHealthCheck,
  getCachedIntegrationHealthSnapshot,
} from "../integration-health";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

function makeIntegration(hc: unknown, configSchema?: Record<string, unknown>): LoadedIntegration {
  return {
    id: "test-integration",
    manifest: {
      name: "Test Integration",
      domains: ["Other"] as [string, ...string[]],
      healthCheck: hc,
      configSchema,
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

describe("integration-health placeholder substitution", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax, not JS interpolation
  it("substitutes a hyphenated ${...} config key in both urlTemplate and a header value", async () => {
    const integration = makeIntegration({
      type: "http",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional string (manifest template syntax, not JS interpolation)
      urlTemplate: "https://api.example.com/status?key=${us-afdc-api-key}",
      headers: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional string (manifest template syntax, not JS interpolation)
        "X-Api-Key": "${us-afdc-api-key}",
      },
    });
    integration.config = { "us-afdc-api-key": "secret-token-123" };

    const results = await executeIntegrationHealthCheck(integration);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("up");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.example.com/status?key=secret-token-123",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Api-Key": "secret-token-123" }),
      }),
    );
  });
});

describe("integration-health secret redaction", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts a secret in an unrecognized query parameter", async () => {
    const integration = makeIntegration(
      {
        type: "http",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional string (manifest template syntax, not JS interpolation)
        urlTemplate: "https://api.example.com/data?lat=0&appid=${apiKey}",
      },
      {
        properties: {
          apiKey: { type: "string", "x-openmapx-secret": true },
        },
      },
    );
    integration.config = { apiKey: "super-secret-value-123" };

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]?.url).toBe("https://api.example.com/data?lat=0&appid=***");
    expect(results[0]?.url).not.toContain("super-secret-value-123");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.example.com/data?lat=0&appid=super-secret-value-123",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("redacts a secret in a path segment", async () => {
    const integration = makeIntegration(
      {
        type: "http",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional string (manifest template syntax, not JS interpolation)
        urlTemplate: "https://firms.example.com/api/area/csv/${firmsApiKey}/VIIRS/0,0,1,1/1",
      },
      {
        properties: {
          firmsApiKey: { type: "string", "x-openmapx-secret": true },
        },
      },
    );
    integration.config = { firmsApiKey: "firms-secret-value-123" };

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]?.url).toContain("/api/area/csv/***/VIIRS");
    expect(results[0]?.url).not.toContain("firms-secret-value-123");
  });

  it("preserves masking for a recognized query parameter", async () => {
    const integration = makeIntegration(
      {
        type: "http",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional string (manifest template syntax, not JS interpolation)
        urlTemplate: "https://api.example.com/status?api_key=${apiKey}",
      },
      {
        properties: {
          apiKey: { type: "string", "x-openmapx-secret": true },
        },
      },
    );
    integration.config = { apiKey: "super-secret-value-123" };

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]?.url).toBe("https://api.example.com/status?api_key=***");
  });

  it("leaves non-secret config values untouched", async () => {
    const integration = makeIntegration(
      {
        type: "http",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional string (manifest template syntax, not JS interpolation)
        urlTemplate: "${endpoint}/health",
      },
      {
        properties: {
          endpoint: { type: "string" },
        },
      },
    );
    integration.config = { endpoint: "https://otp.example.com" };

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]?.url).toBe("https://otp.example.com/health");
  });

  it("redacts secrets from error strings", async () => {
    const secret = "super-secret-value-123";
    const exposedLeadingFragment = secret.slice(0, 10);
    const prefix = "connect failed ".padEnd(110, ".");
    const integration = makeIntegration(
      {
        type: "http",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional string (manifest template syntax, not JS interpolation)
        urlTemplate: "https://api.example.com/data?lat=0&appid=${apiKey}",
      },
      {
        properties: {
          apiKey: { type: "string", "x-openmapx-secret": true },
        },
      },
    );
    integration.config = { apiKey: secret };
    fetchSpy.mockRejectedValue(new Error(`${prefix}${secret}`));

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]?.status).toBe("down");
    expect(results[0]?.error).not.toContain(secret);
    expect(results[0]?.error).not.toContain(exposedLeadingFragment);
  });
});

describe("integration-health impersonation", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(impersonatingFetch).mockClear();
    vi.mocked(impersonatingFetch).mockResolvedValue({ ok: true, status: 200 } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes an impersonate:true probe through the browser-fingerprint client, not global fetch", async () => {
    const integration = makeIntegration({
      type: "http",
      url: "https://api.openchargemap.io/v3/poi/",
      impersonate: true,
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]?.status).toBe("up");
    expect(impersonatingFetch).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a 403 from the impersonated probe as down", async () => {
    vi.mocked(impersonatingFetch).mockResolvedValue({ ok: false, status: 403 } as never);
    const integration = makeIntegration({
      type: "http",
      url: "https://api.openchargemap.io/v3/poi/",
      impersonate: true,
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]?.status).toBe("down");
    expect(results[0]?.error).toBe("HTTP 403");
  });

  it("leaves a normal probe on global fetch (no impersonation)", async () => {
    const integration = makeIntegration({ type: "http", url: "https://api.example.com/health" });

    await executeIntegrationHealthCheck(integration);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(impersonatingFetch).not.toHaveBeenCalled();
  });
});

describe("metered DB API Marketplace health checks", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The credentialless DB API routes reject the request before forwarding it,
    // which proves gateway reachability without consuming an account quota.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["bike-sharing", "Deutsche Bahn GBFS"],
    ["parking", "DB BahnPark"],
  ])("probes %s without sending credentials", async (integrationId, checkName) => {
    const manifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "integrations", integrationId, "manifest.json"), "utf8"),
    ) as { healthCheck: Array<Record<string, unknown>> };
    const healthCheck = manifest.healthCheck.find((check) => check.name === checkName);

    expect(healthCheck).toBeDefined();
    expect(healthCheck?.type).toBe("ping");
    expect(healthCheck).not.toHaveProperty("headers");
    expect(healthCheck).not.toHaveProperty("requiredConfigKeys");

    const integration = makeIntegration(healthCheck);
    integration.config = {
      "db-bike-client-id": "must-not-be-sent",
      "db-bike-api-key": "must-not-be-sent",
      "de-db-bahnpark-client-id": "must-not-be-sent",
      "de-db-bahnpark-api-key": "must-not-be-sent",
    };

    const results = await executeIntegrationHealthCheck(integration);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("up");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).not.toHaveProperty("DB-Client-ID");
    expect(init?.headers).not.toHaveProperty("DB-Client-Id");
    expect(init?.headers).not.toHaveProperty("DB-Api-Key");
  });
});

describe("integration health cache snapshots", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns cached sub-checks and their aggregate without running another probe", async () => {
    const integration = makeIntegration([
      { name: "Primary", type: "http", url: "https://primary.example.com/health" },
      { name: "Fallback", type: "http", url: "https://fallback.example.com/health" },
    ]);
    integration.id = "snapshot-test";

    await executeAllIntegrationHealthChecks([integration]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockClear();

    const snapshot = getCachedIntegrationHealthSnapshot([integration]);

    expect(snapshot.updatedAt).not.toBeNull();
    expect(snapshot.results.map((result) => result.id)).toEqual([
      "snapshot-test:Primary",
      "snapshot-test:Fallback",
      "snapshot-test",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not expose cached results for integrations outside the requested set", async () => {
    const cachedIntegration = makeIntegration({
      type: "http",
      url: "https://cached.example.com/health",
    });
    cachedIntegration.id = "cached-but-not-requested";
    await executeAllIntegrationHealthChecks([cachedIntegration]);

    const requestedIntegration = makeIntegration({
      type: "http",
      url: "https://requested.example.com/health",
    });
    requestedIntegration.id = "requested-without-cache";
    fetchSpy.mockClear();

    expect(getCachedIntegrationHealthSnapshot([requestedIntegration]).results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
