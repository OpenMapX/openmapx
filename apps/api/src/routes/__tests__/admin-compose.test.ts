import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const composeAction = vi.fn();
const applyHardlinksFromPlan = vi.fn().mockResolvedValue([]);
const renderAndPersistCompose = vi.fn();
const adminA = { user: { id: "admin-a" } };

vi.mock("@openmapx/core/server", () => ({
  repoPaths: () => ({ infraDir: "/trusted/infra" }),
  services: {
    buildAppApiServiceEnv: vi.fn(),
    renderCompose: vi.fn(),
  },
}));
vi.mock("../../services/admin-ops", () => ({
  applyHardlinksFromPlan: (...args: unknown[]) => applyHardlinksFromPlan(...args),
  renderAndPersistCompose: (...args: unknown[]) => renderAndPersistCompose(...args),
}));
vi.mock("../../services/service-config-resolver", () => ({
  resolveAllServiceConfigs: vi.fn(),
}));
vi.mock("../../services/service-registry", () => ({ getServiceRegistry: vi.fn() }));
vi.mock("../../utils/docker-compose", () => ({
  dockerComposeAction: (...args: unknown[]) => composeAction(...args),
  STACK_STOP_GUIDANCE:
    "Stack shutdown is unavailable from the web API because it would stop the operations agent. Run the documented host shutdown command instead.",
}));
vi.mock("../../utils/env", () => ({ envString: vi.fn() }));
vi.mock("../../utils/require-admin", () => ({ requireAdmin: vi.fn().mockResolvedValue(adminA) }));
vi.mock("../../utils/route-auth", () => ({ declareRouteAuth: vi.fn() }));

describe("admin Compose routes", () => {
  beforeEach(() => {
    composeAction.mockClear();
    applyHardlinksFromPlan.mockClear();
    renderAndPersistCompose.mockClear();
  });
  it("requires caller-retained idempotency and reuses the same agent key across an ambiguous retry", async () => {
    composeAction.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const { registerAdminComposeRoutes } = await import("../admin-compose.js");
    const app = Fastify({ logger: false });
    await app.register(registerAdminComposeRoutes);

    const missing = await app.inject({ method: "POST", url: "/api/admin/compose/up" });
    expect(missing.statusCode).toBe(400);
    expect(composeAction).not.toHaveBeenCalled();

    const headers = { "idempotency-key": "018f7b8a-3c7a-7b91-a9b0-9d6dd0f51ab1" };
    await app.inject({ method: "POST", url: "/api/admin/compose/up", headers });
    await app.inject({ method: "POST", url: "/api/admin/compose/up", headers });
    const firstKey = composeAction.mock.calls[0]?.[2]?.operationKey;
    expect(firstKey).toMatch(/^opk1_[A-Za-z0-9_-]{43}$/);
    expect(composeAction.mock.calls[1]?.[2]?.operationKey).toBe(firstKey);
    expect(applyHardlinksFromPlan.mock.calls[0]?.[0]?.operationIdentity).toBe(
      applyHardlinksFromPlan.mock.calls[1]?.[0]?.operationIdentity,
    );
    await app.close();
  });

  it("refuses stack shutdown with a non-success status and never submits stack.stop", async () => {
    const { registerAdminComposeRoutes } = await import("../admin-compose.js");
    const app = Fastify({ logger: false });
    await app.register(registerAdminComposeRoutes);
    const response = await app.inject({ method: "POST", url: "/api/admin/compose/down" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error:
        "Stack shutdown is unavailable from the web API because it would stop the operations agent. Run the documented host shutdown command instead.",
    });
    expect(composeAction).not.toHaveBeenCalled();
    await app.close();
  });
});
