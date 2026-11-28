import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAdminRouteMocks } from "./admin-test-helpers";

installAdminRouteMocks();

vi.mock("../../redis.js", () => ({ redis: null }));
vi.mock("../../db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
  sql: { unsafe: async () => [] },
}));
vi.mock("../../db/schema.js", () => ({
  integrationConfig: { integrationId: "integrationId", config: "config" },
  integrationSecret: {},
}));
vi.mock("../../services/attribution/index.js", () => ({
  AttributionIndex: {
    init: async () => ({
      setIntegrationManifests: () => {},
      reload: async () => {},
      close: () => {},
    }),
  },
  defaultMotisLicenseFile: () => null,
  getAttributionIndex: () => null,
  setAttributionIndex: () => {},
}));
vi.mock("../../services/installed-extension-state.js", () => ({
  disabledExtensionIntegrationIds: async () => new Set(),
}));
vi.mock("../../services/capability-bindings.js", () => ({
  loadAllBindingsByIntegration: async () => new Map(),
}));
vi.mock("../../services/service-registry.js", () => ({
  getServiceRegistry: () => {
    throw new Error("service registry unavailable (test mock)");
  },
  resolveRequiresForIntegration: () => new Map(),
}));
vi.mock("../../services/integration-health.js", () => ({
  executeAllIntegrationHealthChecks: async () => [],
  executeIntegrationHealthCheck: async () => [],
  getCachedHealthStatus: () => null,
  getCachedIntegrationHealthSnapshot: () => ({ updatedAt: null, results: [] }),
}));
vi.mock("../../services/provider-health/registry.js", () => ({
  getProviderHealth: () => null,
  ProviderHealth: { init: async () => ({ close: () => {} }) },
  setProviderHealth: () => {},
}));
vi.mock("../../services/metrics/recorder.js", () => ({ getMetricsRecorder: () => null }));
vi.mock("../../services/secrets.js", () => ({
  isSecretsConfigured: () => true,
  secretsKeyProblem: () => null,
  resolveVaultSecrets: async () => ({}),
  getSecret: () => undefined,
}));
// Credentials and application receipts live in the database; the integration declares none.
vi.mock("../../services/integration-credential-status", async (original) => ({
  ...(await original<typeof import("../../services/integration-credential-status")>()),
  inspectIntegrationCredentialView: async () => ({
    revision: "a".repeat(64),
    resolved: {},
    ownership: {},
    credentials: [],
  }),
  computeCredentialStatus: async () => [],
  latestIntegrationApplication: async () => null,
}));
vi.mock("../../services/job-runner.js", () => ({ jobRunner: {} }));
vi.mock("../../services/trusted-config-operations.js", () => ({
  applyTrustedConfiguration: async () => ({}),
}));

const {
  initIntegrations,
  reloadIntegrations,
  setCompatibilityResolver,
  setDisabledExtensionResolver,
  shutdownIntegrations,
} = await import("../../integration-host");
const { initSafeMode } = await import("../../safe-mode");
const { adminIntegrationsRoute } = await import("../admin-integrations");

describe("an installed integration whose setup throws, through the real host", () => {
  let parent: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "omx-admin-load-failure-"));
    vi.stubEnv("OPENMAPX_INTEGRATION_CODE_CACHE_DIR", join(parent, "code-cache"));
  });

  afterEach(async () => {
    await shutdownIntegrations();
    vi.unstubAllEnvs();
    rmSync(parent, { recursive: true, force: true });
  });

  it("is reported as failed, with the phase and the error, in the admin list and detail", async () => {
    const directory = join(parent, "installed", "broken");
    mkdirSync(join(directory, "dist", "backend"), { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "broken",
        name: "Broken",
        version: "1.0.0",
        platform: "1.0",
        license: "MIT",
        domains: ["knowledge"],
        quality: "community",
        backend: { entry: "dist/backend/index.mjs" },
      }),
    );
    writeFileSync(
      join(directory, "dist", "backend", "index.mjs"),
      [
        "// is reported as failed in the admin list and detail",
        "export function setup() {",
        '  throw new Error("upstream token missing");',
        "}",
      ].join("\n"),
    );
    const host = Fastify({ logger: false });
    await initIntegrations(host, [{ directory: join(parent, "installed"), isBuiltIn: false }]);
    const app = Fastify({ logger: false });
    await app.register(adminIntegrationsRoute, { prefix: "/api" });
    await app.ready();

    try {
      const list = await app.inject("/api/admin/integrations");
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([
        expect.objectContaining({
          id: "broken",
          enabled: false,
          loadState: "failed",
          loadErrorPhase: "setup",
          loadError: "upstream token missing",
          status: "failed",
        }),
      ]);
      const detail = await app.inject("/api/admin/integrations/broken");
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        id: "broken",
        enabled: false,
        loadState: "failed",
        loadErrorPhase: "setup",
        loadError: "upstream token missing",
        status: "failed",
      });
    } finally {
      await app.close();
      await host.close();
    }
  });
});

describe("an installed integration the loader holds back, through the real host", () => {
  let parent: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "omx-admin-held-back-"));
    vi.stubEnv("OPENMAPX_INTEGRATION_CODE_CACHE_DIR", join(parent, "code-cache"));
    mkdirSync(join(parent, "runtime"));
  });

  afterEach(async () => {
    await shutdownIntegrations();
    initSafeMode({}, join(parent, "runtime"));
    setDisabledExtensionResolver(null);
    setCompatibilityResolver(null);
    vi.unstubAllEnvs();
    rmSync(parent, { recursive: true, force: true });
  });

  async function listed(): Promise<unknown[]> {
    const directory = join(parent, "installed", "held");
    mkdirSync(join(directory, "dist", "backend"), { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "held",
        name: "Held",
        version: "1.0.0",
        platform: "1.0",
        license: "MIT",
        domains: ["knowledge"],
        quality: "community",
        backend: { entry: "dist/backend/index.mjs" },
      }),
    );
    writeFileSync(
      join(directory, "dist", "backend", "index.mjs"),
      "// held back\nexport function setup() {}\n",
    );
    const host = Fastify({ logger: false });
    await initIntegrations(host, [{ directory: join(parent, "installed"), isBuiltIn: false }]);
    const app = Fastify({ logger: false });
    await app.register(adminIntegrationsRoute, { prefix: "/api" });
    await app.ready();
    try {
      const list = await app.inject("/api/admin/integrations");
      const detail = await app.inject("/api/admin/integrations/held");
      expect(detail.json()).toMatchObject(list.json()[0]);
      return list.json();
    } finally {
      await app.close();
      await host.close();
    }
  }

  it("is in safe mode, neither failed nor switched off", async () => {
    initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, join(parent, "runtime"));
    expect(await listed()).toEqual([
      expect.objectContaining({
        id: "held",
        name: "Held",
        enabled: false,
        loadState: "safe-mode",
        loadError: null,
        loadErrorPhase: null,
        status: "safe-mode",
      }),
    ]);
  });

  it("is incompatible, with the version it needs", async () => {
    setCompatibilityResolver(() => ({ reason: "platform", required: "2.0" }));
    expect(await listed()).toEqual([
      expect.objectContaining({
        loadState: "incompatible",
        loadError: "requires platform 2.0, this is 1.0",
        loadErrorPhase: "import",
        status: "incompatible",
      }),
    ]);
  });

  it("is switched off when its extension is disabled", async () => {
    setDisabledExtensionResolver(async () => new Set(["held"]));
    expect(await listed()).toEqual([
      expect.objectContaining({ loadState: "disabled", loadError: null, status: "disabled" }),
    ]);
  });

  it("failed when the extension state could not be read", async () => {
    setDisabledExtensionResolver(async () => {
      throw new Error("db down");
    });
    expect(await reloadedList()).toEqual([
      expect.objectContaining({
        loadState: "failed",
        loadError: "could not read extension state",
        status: "failed",
      }),
    ]);
  });

  async function reloadedList(): Promise<unknown[]> {
    const resolver = vi.fn(async (): Promise<ReadonlySet<string>> => new Set());
    setDisabledExtensionResolver(resolver);
    await listed();
    setDisabledExtensionResolver(async () => {
      throw new Error("db down");
    });
    await reloadIntegrations();
    const app = Fastify({ logger: false });
    await app.register(adminIntegrationsRoute, { prefix: "/api" });
    try {
      return (await app.inject("/api/admin/integrations")).json();
    } finally {
      await app.close();
    }
  }
});
