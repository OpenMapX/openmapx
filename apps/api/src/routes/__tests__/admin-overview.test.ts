import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installAdminRouteMocks } from "./admin-test-helpers";

installAdminRouteMocks();

function rows(result: unknown[]) {
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    // biome-ignore lint/suspicious/noThenProperty: stands in for a Drizzle query, which is awaited
    then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

vi.mock("../../db/index.js", () => ({
  db: { select: (fields?: object) => rows(fields ? [{ total: 0 }] : []) },
}));
vi.mock("../../services/activity-jobs.js", () => ({
  listActivityJobs: async () => ({ jobs: [] }),
}));
vi.mock("../../services/attention.js", () => ({ listAttention: async () => [] }));
vi.mock("../../services/deployment-mode.js", () => ({ isSelfHostedDeployment: () => false }));
vi.mock("../../services/service-inventory.js", () => ({ readServiceInventory: async () => null }));
vi.mock("../../services/integration-credential-status.js", () => ({
  computeCredentialStatus: async () => [],
  getIntegrationDisplayName: (integration: { manifest: { name: string } }) =>
    integration.manifest.name,
}));
vi.mock("../../services/integration-health.js", () => ({
  getCachedHealthStatus: (id: string) => (id === "down" ? { status: "down", error: "500" } : null),
}));

const integration = (id: string, fields: { enabled: boolean; loadState: string }) => ({
  id,
  manifest: { id, name: id, healthCheck: { kind: "http" } },
  ...fields,
});

vi.mock("../../integration-host.js", () => ({
  getAllIntegrations: () => [
    integration("up", { enabled: true, loadState: "loaded" }),
    integration("down", { enabled: true, loadState: "loaded" }),
    // The host clears `enabled` when the code fails to load; the operator's switch stays on.
    integration("broken", { enabled: false, loadState: "failed" }),
    integration("stale", { enabled: false, loadState: "incompatible" }),
    integration("off", { enabled: false, loadState: "loaded" }),
  ],
}));

const { adminOverviewRoute } = await import("../admin-overview");
const app = Fastify({ logger: false });

beforeAll(async () => {
  await app.register(adminOverviewRoute, { prefix: "/api" });
  await app.ready();
});
afterAll(() => app.close());

describe("admin overview integration counts", () => {
  it("counts an integration whose code failed to load as switched on and unhealthy, as the list does", async () => {
    const response = await app.inject({ method: "GET", url: "/api/admin/overview" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.integrations).toEqual({ total: 5, enabled: 4, unhealthy: 3, unconfigured: 0 });
    // Three of the four switched-on integrations are not working.
    expect(body.systemHealth).toEqual({ status: "down", unhealthyCount: 3 });
  });
});
