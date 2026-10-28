import { SERVICE_ACTIONS } from "@openmapx/core/ops";
import { afterEach, expect, it, vi } from "vitest";
import { serviceFixture } from "../../routes/__tests__/helpers/service-admin-fixtures";

const inspect = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
vi.mock("../ops-client", () => ({
  createApiOpsClient: () => ({}),
  createDurableOpsKey: () => "read",
  executeAndWait: inspect,
}));
vi.mock("../service-registry", () => ({ getServiceRegistry: () => ({ list }) }));
const { readServiceInventory } = await import("../service-inventory");
const { hostControlConfigured, isSelfHostedDeployment } = await import("../deployment-mode");
afterEach(() => vi.unstubAllEnvs());
it("keeps known rows unknown and every action unavailable on acquisition failure", async () => {
  list.mockReturnValue([serviceFixture("motis"), serviceFixture("valhalla")]);
  inspect.mockRejectedValue(new Error("unavailable"));
  const result = await readServiceInventory();
  expect(result.acquisition).toEqual({ state: "unavailable", reason: "ops_unavailable" });
  expect(result.summary).toEqual({ running: 0, stopped: 0, unknown: 2, total: 2 });
  for (const service of result.services) {
    expect(service.status).toBe("unknown");
    expect(Object.keys(service.actions)).toHaveLength(SERVICE_ACTIONS.length);
    expect(Object.values(service.actions).every((action) => !action.available)).toBe(true);
  }
});
it("distinguishes successful empty inventory from a failure and preserves unknown state", async () => {
  list.mockReturnValue([serviceFixture("motis")]);
  inspect.mockResolvedValue({ services: [] });
  expect(await readServiceInventory()).toMatchObject({
    acquisition: { state: "available" },
    summary: { stopped: 1, unknown: 0 },
    services: [{ status: "not-running" }],
  });
  inspect.mockResolvedValue({ services: [{ serviceId: "motis", state: "unknown" }] });
  expect(await readServiceInventory()).toMatchObject({
    acquisition: { state: "available" },
    summary: { stopped: 0, unknown: 1 },
    services: [{ status: "unknown" }],
  });
});
it("reports configured deployment intent independently of live agent acquisition or host paths", () => {
  vi.stubEnv("OPS_AGENT_URL", "");
  vi.stubEnv("OPS_AGENT_TOKEN_FILE", "");
  vi.stubEnv("OPENMAPX_APPLIED_SERVICES", "");
  expect(hostControlConfigured()).toBe(false);
  vi.stubEnv("OPS_AGENT_URL", "http://ops-agent:3000");
  vi.stubEnv("OPS_AGENT_TOKEN_FILE", "/unavailable/token");
  expect(hostControlConfigured()).toBe(true);
  expect(isSelfHostedDeployment()).toBe(true);
});
