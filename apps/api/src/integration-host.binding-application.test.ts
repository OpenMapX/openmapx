import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selected: "engine-a" as string | null,
  root: "",
  failBindings: false,
  registry: null as InstanceType<typeof services.ServiceRegistry> | null,
}));
vi.mock("./redis", () => ({ redis: null }));
vi.mock("./db", () => {
  const rows = (): unknown =>
    Object.assign(Promise.resolve([]), { where: rows, limit: async () => [] });
  return { db: { select: () => ({ from: rows }) }, sql: { unsafe: async () => [] } };
});
vi.mock("./services/capability-bindings", () => ({
  loadAllBindingsByIntegration: async () => {
    if (state.failBindings) throw Error("Synthetic unavailable binding query");
    return new Map([
      ["binding-test", new Map(state.selected ? [["routing-engine", state.selected]] : [])],
    ]);
  },
  listBindingsForIntegration: async () =>
    state.selected ? [{ capability: "routing-engine", serviceId: state.selected }] : [],
  setBinding: async (_key: unknown, id: string) => {
    state.selected = id;
  },
  removeBinding: async () => {
    state.selected = null;
  },
}));
vi.mock("@openmapx/core/server", async (original) => ({
  ...(await original<typeof import("@openmapx/core/server")>()),
  findRepoRoot: () => state.root,
}));
vi.mock("./utils/require-auth", () => ({
  requireAuth: async () => {
    throw Error("Synthetic route has no login");
  },
}));
vi.mock("./utils/require-admin", () => ({
  requireAdmin: async () => ({
    user: { id: "synthetic-admin", role: "admin" },
    session: { id: "synthetic-session" },
  }),
  getAdminSession: () => ({ user: { id: "synthetic-admin" } }),
}));
vi.mock("./services/attribution", () => ({
  AttributionIndex: {
    init: async () => ({ setIntegrationManifests() {}, reload: async () => {}, close() {} }),
  },
  defaultMotisLicenseFile: () => null,
  getAttributionIndex: () => null,
  setAttributionIndex() {},
}));
vi.mock("./services/provider-health/registry", () => ({
  getProviderHealth: () => null,
  ProviderHealth: { init: async () => ({ close() {} }) },
  setProviderHealth() {},
}));
vi.mock("./services/integration-health", () => ({
  executeAllIntegrationHealthChecks: async () => [],
  getCachedIntegrationHealthSnapshot: () => ({ updatedAt: null, results: [] }),
}));

import { initIntegrations, shutdownIntegrations } from "./integration-host";
import { registerCapabilityBindingRoutes } from "./routes/admin-capability-bindings";
import { integrationsRoute } from "./routes/integrations";

let root: string, app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  state.selected = "engine-a";
  state.failBindings = false;
  vi.stubEnv("OPS_AGENT_URL", "");
  vi.stubEnv(services.APPLIED_SERVICES_ENV, "engine-a,engine-b");
  root = mkdtempSync(join(tmpdir(), "openmapx-binding-runtime-"));
  state.root = root;
  for (const id of ["engine-a", "engine-b"]) {
    const dir = join(root, "services", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "service.json"),
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        quality: "built-in",
        container: { image: "example.invalid/synthetic", tag: "1", expose: [8080] },
        provides: ["routing-engine", "unused-capability"],
      }),
    );
  }
  const registryModule = await import("./services/service-registry");
  await registryModule.initServiceRegistry();
  state.registry = registryModule.getServiceRegistry();
  expect(state.registry.list()).toHaveLength(2);
  const directory = join(root, "integrations", "binding-test");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({
      id: "binding-test",
      version: "1.0.0",
      author: "Test",
      license: "MIT",
      domains: ["knowledge"],
      quality: "built-in",
      requires: [{ capability: "routing-engine" }],
      backend: { routes: true },
    }),
  );
  writeFileSync(
    join(directory, "index.ts"),
    `export function setup(ctx){const captured=ctx.getRequiredService('routing-engine');ctx.registerRoute('GET','/bound',async(_req,reply)=>reply.send({serviceId:captured?.serviceId??null}));}`,
  );
  app = Fastify();
  await app.register(integrationsRoute, { prefix: "/api" });
  await initIntegrations(app, [join(root, "integrations")]);
  await registerCapabilityBindingRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await shutdownIntegrations();
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  state.registry = null;
  vi.unstubAllEnvs();
});
it("activates a saved capability binding in the actual trusted provider that captured its requirement", async () => {
  expect((await app.inject("/api/integrations/binding-test/bound")).json()).toEqual({
    serviceId: "engine-a",
  });
  state.selected = "engine-b";
  await (await import("./integration-host")).reloadIntegrations();
  expect((await app.inject("/api/integrations/binding-test/bound")).json()).toEqual({
    serviceId: "engine-b",
  });
});

it("keeps the last provider active when a reload cannot acquire binding authority", async () => {
  const host = await import("./integration-host");
  state.failBindings = true;
  await expect(host.reloadIntegrations()).rejects.toThrow();
  expect((await app.inject("/api/integrations/binding-test/bound")).json()).toEqual({
    serviceId: "engine-a",
  });
});
it("exposes the actual activated generation without leaking configuration values", async () => {
  const host = await import("./integration-host"),
    inspect = (host as unknown as { inspectIntegrationRuntime: (id: string) => unknown })
      .inspectIntegrationRuntime;
  expect(typeof inspect).toBe("function");
  expect(inspect("binding-test")).toMatchObject({
    generationId: expect.any(String),
    configRevision: expect.any(String),
    bindings: { "routing-engine": "engine-a" },
  });
  expect(inspect("missing")).toBeNull();
});

it("rejects a binding for a capability the integration never declared", async () => {
  (await import("./utils/rate-limit")).serviceActionLimit.reset();
  const result = await app.inject({
    method: "POST",
    url: "/api/admin/integrations/binding-test/bindings/unused-capability",
    headers: { "idempotency-key": "binding-undeclared-test-0001" },
    payload: {
      serviceId: "engine-b",
      expectedServiceId: "engine-a",
      expectedRevision: "a".repeat(64),
    },
  });
  expect(result.statusCode).toBe(400);
  expect(state.selected).toBe("engine-a");
});
it("rejects a disabled provider before saving a desired binding", async () => {
  (await import("./utils/rate-limit")).serviceActionLimit.reset();
  state.registry?.applyEnabledIds(new Set(["engine-a"]));
  (await import("./utils/rate-limit")).serviceActionLimit.reset();
  const result = await app.inject({
    method: "POST",
    url: "/api/admin/integrations/binding-test/bindings/routing-engine",
    headers: { "idempotency-key": "binding-disabled-test-0001" },
    payload: {
      serviceId: "engine-b",
      expectedServiceId: "engine-a",
      expectedRevision: "a".repeat(64),
    },
  });
  expect(result.statusCode).toBe(400);
  expect(state.selected).toBe("engine-a");
});
