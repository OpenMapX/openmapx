import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ start: vi.fn(), inspect: vi.fn(), build: vi.fn(), render: vi.fn() }));
const adminA = { user: { id: "admin-a" } };
vi.mock("@openmapx/core/server", () => ({
  repoPaths: () => ({ infraDir: "/trusted/infra" }),
  services: { renderConfiguration: (...args: unknown[]) => f.render(...args) },
}));
vi.mock("../../services/job-runner", () => ({
  jobRunner: { startImmediateCompose: (...args: unknown[]) => f.start(...args) },
}));
vi.mock("../../services/ops-client", () => ({
  createApiOpsClient: () => ({}),
  createDurableOpsKey: () => `opk1_${"p".repeat(43)}`,
  executeAndWait: (...args: unknown[]) => f.inspect(...args),
}));
vi.mock("../../services/desired-selection", () => ({
  readDesiredSelection: async () => ({ roots: ["alpha"], source: "file" }),
}));
vi.mock("../../services/trusted-config-operations", () => ({
  buildConfigurationInput: (...args: unknown[]) => f.build(...args),
  integrationSchemas: () => new Map(),
}));
vi.mock("../../services/service-registry", () => ({
  getServiceRegistry: () => ({ list: () => [] }),
}));
vi.mock("../../utils/docker-compose", () => ({
  STACK_STOP_GUIDANCE:
    "Stack shutdown is unavailable from the web API because it would stop the operations agent. Run the documented host shutdown command instead.",
}));
vi.mock("../../utils/require-admin", () => ({
  requireAdmin: vi.fn().mockResolvedValue(adminA),
  getAdminSession: () => adminA,
}));
vi.mock("../../utils/route-auth", () => ({ declareRouteAuth: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  f.start.mockResolvedValue({
    ok: true,
    stdout: "",
    hardlinks: { applied: true, linked: 0, skipped: 0, pruned: 0, entries: 0 },
  });
});
async function app() {
  const a = Fastify({ logger: false });
  const { registerAdminComposeRoutes } = await import("../admin-compose.js");
  await a.register(registerAdminComposeRoutes, { prefix: "/api" });
  return a;
}
describe("admin Compose routes", () => {
  it("requires caller-retained idempotency and retains the original job intent across an ambiguous retry", async () => {
    const a = await app();
    try {
      expect((await a.inject({ method: "POST", url: "/api/admin/compose/up" })).statusCode).toBe(
        400,
      );
      expect(f.start).not.toHaveBeenCalled();
      const headers = { "idempotency-key": "018f7b8a-3c7a-7b91-a9b0-9d6dd0f51ab1" };
      f.start.mockRejectedValueOnce(Error("synthetic response loss"));
      expect(
        (await a.inject({ method: "POST", url: "/api/admin/compose/up", headers })).statusCode,
      ).toBe(500);
      expect(
        (await a.inject({ method: "POST", url: "/api/admin/compose/up", headers })).statusCode,
      ).toBe(200);
      const original = f.start.mock.calls[0]?.[0];
      expect(original).toMatchObject({
        actorId: "admin-a",
        operationKey: expect.stringMatching(/^opk1_[A-Za-z0-9_-]{43}$/),
      });
      expect(f.start.mock.calls[1]?.[0]).toEqual(original);
    } finally {
      await a.close();
    }
  });
  it("refuses stack shutdown and never queues a job", async () => {
    const a = await app();
    try {
      const response = await a.inject({ method: "POST", url: "/api/admin/compose/down" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        ok: false,
        error: expect.stringContaining("host shutdown"),
      });
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });
  it("uses read-only platform inspection for preview without allocating a source witness", async () => {
    const platform = { version: 1, domain: { source: "database", value: "adopted.example.test" } };
    f.inspect.mockResolvedValue({ revisionId: null, integrationConfigDigests: [], platform });
    f.build.mockResolvedValue({
      domain: "adopted.example.test",
      platform,
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    });
    f.render.mockReturnValue({ rendered: { composeYaml: "services: {}\n" } });
    const a = await app();
    try {
      const response = await a.inject("/api/admin/compose/preview");
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("services: {}\n");
      expect(f.inspect.mock.calls[0]?.[1]).toEqual({ kind: "configuration.inspect" });
      expect(f.build).toHaveBeenCalledWith(undefined, platform);
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });
});
