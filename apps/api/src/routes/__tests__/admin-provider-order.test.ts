import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installAdminRouteMocks } from "./admin-test-helpers.js";

const { requireAdmin: mockRequireAdmin } = installAdminRouteMocks();

const providerOrderSchema = {
  type: "object",
  properties: {
    providerOrder: { type: "array", items: { type: "string" }, maxItems: 64, default: [] },
  },
};

function loaded(id: string, name: string, domain: string, isBuiltIn = true) {
  return {
    id,
    enabled: true,
    isBuiltIn,
    loadState: "loaded",
    directory: `/integrations/${id}`,
    manifest: {
      id,
      name,
      version: "1.0.0",
      domains: [domain],
      configSchema: domain === "data-source" ? providerOrderSchema : undefined,
    },
    providers: new Map([[domain, [{ id: `${id}-provider` }]]]),
    strings: {},
  };
}

const routingOrchestrator = {
  ...loaded("routing", "Routing", "data-source"),
  providers: new Map(),
};
const routingIntegrations = [
  loaded("routing-brouter", "BRouter", "routing"),
  loaded("routing-valhalla", "Valhalla", "routing"),
  loaded("routing-osrm", "OSRM", "routing", false),
];
const geocoders = [
  loaded("geocoding-maptiler", "MapTiler", "geocoding"),
  loaded("geocoding-photon", "Photon", "geocoding", false),
];

const hostMock = vi.hoisted(() => ({
  getProviderOrder: vi.fn<(domain: string) => readonly string[]>(),
  getIntegrationsByDomain: vi.fn<(domain: string) => unknown[]>(),
  getIntegration: vi.fn<(id: string) => unknown>(),
}));
vi.mock("../../integration-host.js", () => ({
  getProviderOrder: (domain: string) => hostMock.getProviderOrder(domain),
  getIntegrationsByDomain: (domain: string) => hostMock.getIntegrationsByDomain(domain),
  getIntegration: (id: string) => hostMock.getIntegration(id),
  getAllIntegrations: () => [routingOrchestrator, ...routingIntegrations, ...geocoders],
  inspectIntegrationRuntime: () => null,
  resolveConfigWithSources: async () => ({}),
}));

const mockApply = vi.fn();
vi.mock("../../services/trusted-config-operations.js", () => ({
  applyTrustedConfiguration: (...args: unknown[]) => mockApply(...args),
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { adminProviderOrderRoute } = await import("../admin-provider-order.js");
  const { adminIntegrationsRoute } = await import("../admin-integrations.js");
  app = Fastify({ logger: false });
  await app.register(adminProviderOrderRoute, { prefix: "/api" });
  await app.register(adminIntegrationsRoute, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

function hostWith(orders: Record<string, readonly string[]>) {
  hostMock.getProviderOrder.mockImplementation((domain) => orders[domain] ?? []);
  hostMock.getIntegrationsByDomain.mockImplementation((domain) =>
    domain === "routing" ? routingIntegrations : domain === "geocoding" ? geocoders : [],
  );
}

describe("GET /api/admin/provider-order", () => {
  it("lists the listed integrations first, then the other loaded ones", async () => {
    hostWith({ routing: ["routing-osrm"] });
    const res = await app.inject({ method: "GET", url: "/api/admin/provider-order" });
    expect(res.statusCode).toBe(200);
    const routing = res
      .json<{ domains: Array<{ domain: string }> }>()
      .domains.find((entry) => entry.domain === "routing");
    expect(routing).toEqual({
      domain: "routing",
      orchestratorId: "routing",
      unlisted: "append",
      stored: ["routing-osrm"],
      effective: [
        { integrationId: "routing-osrm", name: "OSRM", isBuiltIn: false, listed: true },
        { integrationId: "routing-brouter", name: "BRouter", isBuiltIn: true, listed: false },
        { integrationId: "routing-valhalla", name: "Valhalla", isBuiltIn: true, listed: false },
      ],
    });
  });

  it("offers the unlisted integrations of a domain that excludes them", async () => {
    hostWith({ geocoding: ["geocoding-maptiler"] });
    const res = await app.inject({ method: "GET", url: "/api/admin/provider-order" });
    const geocoding = res
      .json<{ domains: Array<{ domain: string }> }>()
      .domains.find((entry) => entry.domain === "geocoding");
    expect(geocoding).toMatchObject({
      unlisted: "exclude",
      effective: [
        { integrationId: "geocoding-maptiler", listed: true },
        { integrationId: "geocoding-photon", listed: false },
      ],
    });
  });

  it("covers every domain that has an orchestrator", async () => {
    hostWith({});
    const res = await app.inject({ method: "GET", url: "/api/admin/provider-order" });
    const domains = res.json<{ domains: Array<{ domain: string }> }>().domains;
    expect(domains).toHaveLength(22);
    expect(domains.map((entry) => entry.domain)).not.toContain("hazards");
  });

  it("refuses a request without an admin session", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );
    const res = await app.inject({ method: "GET", url: "/api/admin/provider-order" });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/admin/integrations/:id/config with a provider order", () => {
  const patch = (payload: unknown) =>
    app.inject({
      method: "PATCH",
      url: "/api/admin/integrations/routing/config",
      headers: { "idempotency-key": randomUUID() },
      payload: payload as Record<string, unknown>,
    });

  it("accepts a string array", async () => {
    hostMock.getIntegration.mockReturnValue(routingOrchestrator);
    mockApply.mockResolvedValue({
      revisionId: "revision_1",
      integrationReload: { message: "Integrations reloaded", reloaded: 1, enabled: 1 },
    });
    const res = await patch({ providerOrder: ["x y"] });
    expect(res.statusCode).toBe(200);
    expect(mockApply).toHaveBeenCalledWith(
      expect.objectContaining({
        overlay: expect.objectContaining({
          changes: [expect.objectContaining({ set: { providerOrder: ["x y"] } })],
        }),
      }),
    );
  });

  it("refuses a value that is not an array", async () => {
    hostMock.getIntegration.mockReturnValue(routingOrchestrator);
    const res = await patch({ providerOrder: "a" });
    expect(res.statusCode).toBe(400);
    expect(mockApply).not.toHaveBeenCalled();
  });
});
