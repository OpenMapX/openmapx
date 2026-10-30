import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SafeFetchStatusOptions } from "@openmapx/core/server";
import type { LoadedIntegration } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coreServerMocks = vi.hoisted(() => ({
  resolvePublicConnectionAddresses: vi.fn(),
  safeFetchStatus: vi.fn(),
}));
const dnsMocks = vi.hoisted(() => ({ lookup: vi.fn() }));
const serviceUrls = vi.hoisted(() => new Map<string, string>());
const netMocks = vi.hoisted(() => ({ createConnection: vi.fn() }));

vi.mock("@openmapx/core/server", () => coreServerMocks);
vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  ...netMocks,
}));
vi.mock("node:dns/promises", () => dnsMocks);

// Mock service-registry before importing the module under test
vi.mock("../service-registry", () => ({
  serviceUrl: (id: string) => {
    if (id === "valhalla") return "http://valhalla:8002";
    return serviceUrls.get(id);
  },
}));

// Mock health-history to avoid DB side effects
vi.mock("../health-history", () => ({
  recordHealthResult: vi.fn().mockResolvedValue(undefined),
}));

import { recordHealthResult } from "../health-history";
import {
  executeAllIntegrationHealthChecks,
  executeIntegrationHealthCheck,
  getCachedIntegrationHealthSnapshot,
} from "../integration-health";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

beforeEach(() => {
  coreServerMocks.safeFetchStatus
    .mockReset()
    .mockImplementation(
      async (
        url: string,
        opts: { headers?: Record<string, string> } = {},
      ): Promise<{ status: number; headers: Headers; finalUrl: string }> => {
        const response = await globalThis.fetch(url, {
          method: "GET",
          headers: opts.headers,
        });
        return {
          status: response.status,
          headers: response.headers,
          finalUrl: response.url || url,
        };
      },
    );
  coreServerMocks.resolvePublicConnectionAddresses
    .mockReset()
    .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  netMocks.createConnection
    .mockReset()
    .mockImplementation((_options: unknown, onConnect: () => void) => {
      const socket = {
        destroy: vi.fn(),
        on: vi.fn(),
        setTimeout: vi.fn(),
      };
      socket.on.mockReturnValue(socket);
      socket.setTimeout.mockReturnValue(socket);
      queueMicrotask(onConnect);
      return socket;
    });
});

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

  it("reports a connection-time DNS change as down", async () => {
    coreServerMocks.safeFetchStatus.mockRejectedValue(
      new Error('URL host "rebind.example.com" is not allowed'),
    );
    const integration = makeIntegration({
      type: "http",
      url: "https://rebind.example.com/health",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]).toMatchObject({ status: "down" });
    expect(results[0]?.error).toMatch(/not allowed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a redirect to a private address as down", async () => {
    coreServerMocks.safeFetchStatus.mockRejectedValue(
      new Error('URL host "127.0.0.1" is not allowed'),
    );
    const integration = makeIntegration({
      type: "http",
      url: "https://public.example.com/health",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]).toMatchObject({ status: "down" });
    expect(results[0]?.error).toMatch(/not allowed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("classifies a public non-success response without reading its body", async () => {
    coreServerMocks.safeFetchStatus.mockResolvedValue({
      status: 503,
      headers: new Headers(),
      finalUrl: "https://api.example.com/health",
    });
    const integration = makeIntegration({
      type: "http",
      url: "https://api.example.com/health",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]).toMatchObject({ status: "down", error: "HTTP 503" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("delegates final-response cancellation to the status-only transport", async () => {
    fetchSpy.mockRejectedValue(new Error("raw fetch must not run"));
    coreServerMocks.safeFetchStatus.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      finalUrl: "https://api.example.com/health",
    });
    const integration = makeIntegration({
      type: "http",
      url: "https://api.example.com/health",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]).toMatchObject({ status: "up" });
    expect(fetchSpy).not.toHaveBeenCalled();
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
    expect(coreServerMocks.safeFetchStatus).toHaveBeenCalledWith(
      "http://valhalla:8002/health",
      expect.objectContaining({ allowPrivateHosts: ["valhalla"] }),
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
    coreServerMocks.resolvePublicConnectionAddresses.mockRejectedValue(
      new Error("private destination"),
    );
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
    expect(netMocks.createConnection).not.toHaveBeenCalled();
  });

  it("connects a TCP probe directly to the approved address", async () => {
    coreServerMocks.resolvePublicConnectionAddresses.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ]);
    const integration = makeIntegration({
      type: "tcp",
      url: "rebind.example.com:443",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]).toMatchObject({ status: "up", url: "rebind.example.com:443" });
    expect(coreServerMocks.resolvePublicConnectionAddresses).toHaveBeenCalledOnce();
    expect(netMocks.createConnection).toHaveBeenCalledWith(
      { host: "93.184.216.34", port: 443 },
      expect.any(Function),
    );
  });

  it("bounds TCP address resolution with the health-check timeout", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    coreServerMocks.resolvePublicConnectionAddresses.mockImplementation(
      async (_url: URL, signal?: AbortSignal) =>
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const integration = makeIntegration({
      type: "tcp",
      url: "slow-dns.example.com:443",
    });

    const resultPromise = executeIntegrationHealthCheck(integration);
    controller.abort(new DOMException("The operation timed out", "TimeoutError"));
    const results = await resultPromise;

    expect(results[0]).toMatchObject({ status: "down", error: "Timeout" });
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(netMocks.createConnection).not.toHaveBeenCalled();
  });

  it("does not expose the approved address when a TCP connection fails", async () => {
    const approvedAddress = "93.184.216.34";
    coreServerMocks.resolvePublicConnectionAddresses.mockResolvedValue([
      { address: approvedAddress, family: 4 },
    ]);
    netMocks.createConnection.mockImplementation(() => {
      const handlers = new Map<string, (error: Error) => void>();
      const socket = {
        destroy: vi.fn(),
        on: vi.fn((event: string, handler: (error: Error) => void) => {
          handlers.set(event, handler);
          return socket;
        }),
        setTimeout: vi.fn(),
      };
      socket.setTimeout.mockReturnValue(socket);
      queueMicrotask(() => {
        const error = Object.assign(new Error(`connect ECONNREFUSED ${approvedAddress}:443`), {
          code: "ECONNREFUSED",
        });
        handlers.get("error")?.(error);
      });
      return socket;
    });
    const integration = makeIntegration({
      type: "tcp",
      url: "rebind.example.com:443",
    });

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]).toMatchObject({ status: "down", error: "Connection refused" });
    expect(results[0]?.error).not.toContain(approvedAddress);
  });
});

describe("configured health-header redirect boundaries", () => {
  const marker = "fixture-health-header-secret";
  const transport = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(async () => {
    const real =
      await vi.importActual<typeof import("@openmapx/core/server")>("@openmapx/core/server");
    coreServerMocks.safeFetchStatus.mockImplementation(
      (url: string, opts: SafeFetchStatusOptions) =>
        real.safeFetchStatus(url, { ...opts, fetchImplementation: transport }),
    );
    dnsMocks.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    transport.mockReset();
    vi.mocked(recordHealthResult).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function credentialCheck(header: string, url = "https://status.example.com/health") {
    const integration = makeIntegration(
      {
        type: "http",
        url,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest placeholder
        headers: { [header]: header === "Authorization" ? "Bearer ${apiKey}" : "${apiKey}" },
      },
      { properties: { apiKey: { type: "string", "x-openmapx-secret": true } } },
    );
    integration.config = { apiKey: marker };
    return integration;
  }

  it.each([
    ["Authorization", "https://other.example.com/ready"],
    ["X-Api-Key", "https://other.example.com/ready"],
    ["Authorization", "https://status.example.com:444/ready"],
    ["X-Api-Key", "http://status.example.com/ready"],
  ])(
    "blocks %s before a second transport request to %s without exposing the header in status outputs",
    async (header, target) => {
      const logs = ["error", "warn", "info", "log"] as const;
      const logSpies = logs.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
      transport.mockImplementation(async (input) =>
        String(input) === "https://status.example.com/health"
          ? new Response(null, { status: 302, headers: { location: target } })
          : new Response(null, { status: 200 }),
      );
      const integration = credentialCheck(header);
      const results = await executeIntegrationHealthCheck(integration);

      expect(transport).toHaveBeenCalledTimes(1);
      expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get(header)).toContain(marker);
      expect(results[0]).toMatchObject({
        status: "down",
        error: expect.stringMatching(/redirect/i),
      });
      transport.mockClear();
      const refreshed = await executeAllIntegrationHealthChecks([integration]);
      const snapshot = getCachedIntegrationHealthSnapshot([integration]);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(refreshed[0]?.status).toBe("down");
      expect(snapshot.results[0]?.status).toBe("down");
      expect(recordHealthResult).toHaveBeenCalledWith(
        "test-integration",
        "unhealthy",
        expect.any(Number),
        expect.stringMatching(/redirect/i),
      );
      expect(
        JSON.stringify({
          results,
          refreshed,
          snapshot,
          history: vi.mocked(recordHealthResult).mock.calls,
          logs: logSpies.map((spy) => spy.mock.calls),
        }),
      ).not.toContain(marker);
    },
  );

  it.each(["Authorization", "X-Api-Key"])(
    "retains %s on an allowed same-origin redirect",
    async (header) => {
      transport
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: "https://status.example.com:443/ready" },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const results = await executeIntegrationHealthCheck(credentialCheck(header));

      expect(results[0]?.status).toBe("up");
      expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
        "https://status.example.com/health",
        "https://status.example.com/ready",
      ]);
      for (const [, init] of transport.mock.calls) {
        expect(new Headers(init?.headers).get(header)).toBe(
          header === "Authorization" ? `Bearer ${marker}` : marker,
        );
      }
    },
  );

  it.each([undefined, {}])(
    "keeps cross-origin redirects for checks with no configured headers (%s)",
    async (headers) => {
      transport
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: "https://other.example.com/ready" },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const results = await executeIntegrationHealthCheck(
        makeIntegration({ type: "http", url: "https://status.example.com/health", headers }),
      );

      expect(results[0]?.status).toBe("up");
      expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
        "https://status.example.com/health",
        "https://other.example.com/ready",
      ]);
      expect(new Headers(transport.mock.calls[0]?.[1]?.headers).has("User-Agent")).toBe(true);
    },
  );

  it("preserves configured service-host private-address access and same-origin redirects", async () => {
    dnsMocks.lookup.mockResolvedValue([{ address: "10.0.0.4", family: 4 }]);
    transport
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/ready" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const integration = credentialCheck("X-Api-Key");
    integration.manifest.healthCheck = {
      type: "http",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest placeholder
      urlTemplate: "${service:valhalla}/health",
      headers: { "X-Api-Key": marker },
    };

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]?.status).toBe("up");
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "http://valhalla:8002/health",
      "http://valhalla:8002/ready",
    ]);
    expect(new Headers(transport.mock.calls[1]?.[1]?.headers).get("X-Api-Key")).toBe(marker);
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

// biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
describe("integration-health ${endpoint:...} placeholders", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    serviceUrls.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function manifestIntegration(id: string): LoadedIntegration {
    const manifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, `integrations/${id}/manifest.json`), "utf8"),
    );
    return { ...makeIntegration(manifest.healthCheck), id, manifest, isBuiltIn: true };
  }

  it.each([
    [
      "elsewhere in the URL",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
      { type: "http", urlTemplate: "https://collector.example/?u=${endpoint:overpass}" },
    ],
    [
      "as a host prefix",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
      { type: "http", urlTemplate: "${endpoint:overpass}@collector.example/status" },
    ],
    [
      "in a header",
      {
        type: "http",
        url: "https://collector.example/status",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
        headers: { "X-Upstream": "${endpoint:overpass}" },
      },
    ],
  ])("never sends the operator's endpoint %s", async (_where, healthCheck) => {
    vi.stubEnv("OVERPASS_URL", "https://mapper:s3cret-pass@overpass.example.org");

    const [status] = await executeIntegrationHealthCheck({
      ...makeIntegration(healthCheck),
      isBuiltIn: true,
    });

    expect(status).toMatchObject({ status: "down", url: "health check misconfigured" });
    expect(coreServerMocks.safeFetchStatus).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toMatch(/s3cret-pass|mapper/);
  });

  it("does not resolve an endpoint for a community integration", async () => {
    serviceUrls.set("overpass", "http://overpass:80");

    const [status] = await executeIntegrationHealthCheck(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
      makeIntegration({ type: "http", urlTemplate: "${endpoint:overpass}/api/status" }),
    );

    expect(status).toMatchObject({
      status: "down",
      error: "endpoint placeholders are reserved for built-in integrations",
    });
    expect(coreServerMocks.safeFetchStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["poi-overpass", "poi-overpass"],
    ["transit-overpass", "transit-overpass"],
    ["overlay-hiking", "overlay-hiking:OpenStreetMap Overpass"],
  ])("%s probes the self-hosted Overpass when it is enabled", async (id, statusId) => {
    vi.stubEnv("OVERPASS_URL", "https://overpass.example.org");
    serviceUrls.set("overpass", "http://overpass:80");

    const statuses = await executeIntegrationHealthCheck(manifestIntegration(id));

    expect(statuses.find((status) => status.id === statusId)).toMatchObject({
      status: "up",
      url: "http://overpass:80/api/status",
    });
    expect(coreServerMocks.safeFetchStatus).toHaveBeenCalledWith(
      "http://overpass:80/api/status",
      expect.objectContaining({ allowPrivateHosts: ["overpass"] }),
    );
    expect(fetchSpy.mock.calls.map((call: unknown[]) => String(call[0]))).not.toContain(
      "https://overpass-api.de/api/status",
    );
  });

  it("probes an operator's private instance, sending its URL credentials as Basic auth", async () => {
    vi.stubEnv("OVERPASS_URL", "http://mapper:s3cret-pass@overpass.lan:8080/api/interpreter");

    const [status] = await executeIntegrationHealthCheck(manifestIntegration("poi-overpass"));

    expect(status).toMatchObject({ status: "up", url: "http://overpass.lan:8080/api/status" });
    expect(coreServerMocks.safeFetchStatus).toHaveBeenCalledWith(
      "http://overpass.lan:8080/api/status",
      expect.objectContaining({
        allowPrivateHosts: ["overpass.lan"],
        allowedRedirectOrigin: "http://overpass.lan:8080",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("mapper:s3cret-pass").toString("base64")}`,
        }),
      }),
    );
  });

  it("never shows URL credentials, even in an error message that repeats them", async () => {
    vi.stubEnv("OVERPASS_URL", "https://mapper:s3cret-pass@overpass.example.org");
    coreServerMocks.safeFetchStatus.mockRejectedValue(
      new Error("request to https://mapper:s3cret-pass@overpass.example.org failed"),
    );

    const [status] = await executeIntegrationHealthCheck(manifestIntegration("poi-overpass"));

    expect(status?.status).toBe("down");
    expect(JSON.stringify(status)).not.toMatch(/s3cret-pass|mapper/);
  });

  it("probes the public default, as a public host, when nothing is configured", async () => {
    vi.stubEnv("OVERPASS_URL", "");

    const [status] = await executeIntegrationHealthCheck(manifestIntegration("transit-overpass"));

    expect(status?.url).toBe("https://overpass-api.de/api/status");
    expect(coreServerMocks.safeFetchStatus).toHaveBeenCalledWith(
      "https://overpass-api.de/api/status",
      expect.objectContaining({ allowPrivateHosts: [] }),
    );
  });

  it("reports an endpoint id it does not know as unconfigured, without a request", async () => {
    const [status] = await executeIntegrationHealthCheck({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: manifest template syntax
      ...makeIntegration({ type: "http", urlTemplate: "${endpoint:nominatim}/status" }),
      isBuiltIn: true,
    });

    expect(status).toMatchObject({
      status: "unconfigured",
      url: "nominatim endpoint not configured",
    });
    expect(coreServerMocks.safeFetchStatus).not.toHaveBeenCalled();
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
    coreServerMocks.safeFetchStatus.mockRejectedValue(new Error(`${prefix}${secret}`));

    const results = await executeIntegrationHealthCheck(integration);

    expect(results[0]?.status).toBe("down");
    expect(results[0]?.error).not.toContain(secret);
    expect(results[0]?.error).not.toContain(exposedLeadingFragment);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["fixture'secret value", "fixture[secret value"])(
    "redacts the WHATWG URL representation of secret %s from transport errors",
    async (secret) => {
      const integration = makeIntegration(
        {
          type: "http",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional string (manifest template syntax, not JS interpolation)
          urlTemplate: "https://api.example.com/status?appid=${apiKey}",
        },
        {
          properties: {
            apiKey: { type: "string", "x-openmapx-secret": true },
          },
        },
      );
      integration.config = { apiKey: secret };
      const serializedUrl = new URL(`https://api.example.com/status?appid=${secret}`).toString();
      coreServerMocks.safeFetchStatus.mockRejectedValue(
        new Error(`Too many redirects while fetching ${serializedUrl}`),
      );

      const results = await executeIntegrationHealthCheck(integration);

      expect(results[0]?.error).toContain("***");
      expect(results[0]?.error).not.toContain(secret);
      expect(results[0]?.error).not.toContain(
        new URL(serializedUrl).search.slice("?appid=".length),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
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

  it("probes bike-sharing without sending credentials", async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "integrations", "bike-sharing", "manifest.json"), "utf8"),
    ) as { healthCheck: Array<Record<string, unknown>> };
    const healthCheck = manifest.healthCheck.find((check) => check.name === "Deutsche Bahn GBFS");

    expect(healthCheck).toBeDefined();
    expect(healthCheck?.type).toBe("ping");
    expect(healthCheck).not.toHaveProperty("headers");
    expect(healthCheck).not.toHaveProperty("requiredConfigKeys");

    const integration = makeIntegration(healthCheck);
    integration.config = {
      "db-bike-client-id": "must-not-be-sent",
      "db-bike-api-key": "must-not-be-sent",
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

describe("Entur composite health dispatch", () => {
  it.each(["transit-entur", "live-transit-entur"] as const)(
    "dispatches %s to its registered instance and probes every declared API family",
    async (id) => {
      const { createMockIntegrationContext, fakeHttpClient } = await import(
        "@openmapx/integration-framework/testing"
      );
      const { setup } =
        id === "transit-entur"
          ? await import("../../../../../integrations/transit-entur/index")
          : await import("../../../../../integrations/live-transit-entur/index");
      const manifest = JSON.parse(
        readFileSync(resolve(REPO_ROOT, `integrations/${id}/manifest.json`), "utf8"),
      );
      const http = fakeHttpClient(({ url }) => ({
        status: 200,
        headers: {},
        body: JSON.stringify(
          url.includes("/stop-places/")
            ? { id: "NSR:StopPlace:337" }
            : url.includes("/vehicles/")
              ? { data: { vehicles: [] } }
              : { data: { stopPlace: { id: "NSR:StopPlace:337" }, situations: [] } },
        ),
      }));
      const ctx = createMockIntegrationContext({ id, manifest, http });
      Object.assign(ctx, {
        upstreamRuntime: {
          admitSharedRequest: async () => ({ allowed: true }),
          deferSharedRequests: async () => {},
        },
      });
      setup(ctx);
      const integration = {
        ...makeIntegration(manifest.healthCheck),
        id,
        manifest,
        customHealthCheck: ctx.registered.healthChecks[0],
      };
      const statuses = await executeIntegrationHealthCheck(integration);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].status).toBe("up");
      expect(http.calls.map((call) => new URL(call.url).pathname).sort()).toEqual(
        id === "transit-entur"
          ? [
              "/journey-planner/v3/graphql",
              "/realtime/v2/vehicles/graphql",
              "/stop-places/v1/read/stop-places/NSR:StopPlace:337",
            ]
          : ["/journey-planner/v3/graphql", "/realtime/v2/vehicles/graphql"],
      );
      expect(coreServerMocks.safeFetchStatus).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["transit-entur", "entur-journey-planner"],
    ["transit-entur", "entur-vehicles"],
    ["transit-entur", "entur-nsr"],
    ["live-transit-entur", "entur-live-vehicles"],
    ["live-transit-entur", "entur-live-situations"],
  ] as const)("marks %s down when %s policy denies its acquisition", async (id, source) => {
    const { createMockIntegrationContext, fakeHttpClient } = await import(
      "@openmapx/integration-framework/testing"
    );
    const { setup } =
      id === "transit-entur"
        ? await import("../../../../../integrations/transit-entur/index")
        : await import("../../../../../integrations/live-transit-entur/index");
    const manifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, `integrations/${id}/manifest.json`), "utf8"),
    );
    const ctx = createMockIntegrationContext({
      id,
      manifest,
      http: fakeHttpClient(({ url }) => ({
        status: 200,
        headers: {},
        body: JSON.stringify(
          url.includes("/stop-places/")
            ? { id: "NSR:StopPlace:337" }
            : { data: { stopPlace: { id: "NSR:StopPlace:337" }, vehicles: [], situations: [] } },
        ),
      })),
    });
    ctx.getDisallowedSourceIds = async () => new Set([source]);
    Object.assign(ctx, {
      upstreamRuntime: {
        admitSharedRequest: async () => ({ allowed: true }),
        deferSharedRequests: async () => {},
      },
    });
    setup(ctx);
    const statuses = await executeIntegrationHealthCheck({
      ...makeIntegration(manifest.healthCheck),
      id,
      manifest,
      customHealthCheck: ctx.registered.healthChecks[0],
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("down");
    expect(coreServerMocks.safeFetchStatus).not.toHaveBeenCalled();
  });
});

describe("scheduled integration health checks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    vi.mocked(recordHealthResult).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mangrove(): LoadedIntegration {
    const manifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "integrations/reviews-mangrove/manifest.json"), "utf8"),
    );
    return { ...makeIntegration(manifest.healthCheck), id: "reviews-mangrove", manifest };
  }

  it("uses a static Mangrove endpoint and probes only once per 15 minutes", async () => {
    const integration = mangrove();
    await executeAllIntegrationHealthChecks([integration], { scheduled: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.mangrove.reviews/robots.txt",
      expect.anything(),
    );
    vi.mocked(globalThis.fetch).mockClear();
    vi.mocked(recordHealthResult).mockClear();
    for (let minute = 1; minute < 15; minute++) {
      vi.setSystemTime(Date.now() + 60_000);
      const cached = await executeAllIntegrationHealthChecks([integration], { scheduled: true });
      expect(cached[0]?.status).toBe("up");
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(recordHealthResult).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 60_000);
    await executeAllIntegrationHealthChecks([integration], { scheduled: true });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("keeps the default minute cadence and permits explicit on-demand checks", async () => {
    const normal = makeIntegration({ type: "http", url: "https://example.org/health" });
    const external = mangrove();
    await executeAllIntegrationHealthChecks([normal, external], { scheduled: true });
    vi.mocked(globalThis.fetch).mockClear();
    vi.setSystemTime(Date.now() + 60_000);
    await executeAllIntegrationHealthChecks([normal, external], { scheduled: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await executeAllIntegrationHealthChecks([external]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not overlap slow scheduled probes and seeds replacement generations", async () => {
    const integration = mangrove();
    let finish!: (response: Response) => void;
    vi.mocked(globalThis.fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = executeAllIntegrationHealthChecks([integration], { scheduled: true });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await executeAllIntegrationHealthChecks([integration], { scheduled: true });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    finish(new Response(null, { status: 503 }));
    await first;
    const replacement = mangrove();
    await executeAllIntegrationHealthChecks([replacement], { scheduled: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(getCachedIntegrationHealthSnapshot([replacement]).results[0]?.status).toBe("up");
  });
});
