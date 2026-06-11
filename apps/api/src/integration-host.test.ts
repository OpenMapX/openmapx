/**
 * Characterization tests for integration-host.ts — loader, route dispatch, and
 * reload/shutdown. These tests pin observable behavior so plan-012 refactors
 * can prove they preserved it.
 *
 * All tests exercise only the public API; no internals are imported or patched.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fixtures directory that contains our test integrations.
// import.meta.url points to this file: apps/api/src/integration-host.test.ts
// One level up is apps/api/src/, then __tests__/fixtures/integrations.
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "../__tests__/fixtures/integrations");

// Module mocks must be declared before any imports of the modules they replace.
// Each mock covers one or more internal dependencies that would otherwise
// require live infrastructure (DB, Redis, attribution service, etc.).

vi.mock("./redis.js", () => ({ redis: null }));

vi.mock("./db.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
  sql: { unsafe: vi.fn().mockResolvedValue([]) },
}));

vi.mock("./db/schema.js", () => ({
  integrationConfig: { integrationId: "integrationId", config: "config" },
  integrationSecret: {},
}));

vi.mock("./services/attribution/index.js", () => ({
  AttributionIndex: {
    init: vi.fn().mockResolvedValue({
      setIntegrationManifests: vi.fn(),
      reload: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    }),
  },
  defaultMotisLicenseFile: vi.fn().mockReturnValue(null),
  getAttributionIndex: vi.fn().mockReturnValue(null),
  setAttributionIndex: vi.fn(),
}));

vi.mock("./services/capability-bindings.js", () => ({
  loadAllBindingsByIntegration: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("./services/service-registry.js", () => ({
  getServiceRegistry: vi.fn().mockImplementation(() => {
    throw new Error("service registry unavailable (test mock)");
  }),
  resolveRequiresForIntegration: vi.fn().mockReturnValue(new Map()),
}));

vi.mock("./services/integration-health.js", () => ({
  executeAllIntegrationHealthChecks: vi.fn().mockResolvedValue([]),
}));

vi.mock("./services/provider-health/registry.js", () => ({
  getProviderHealth: vi.fn().mockReturnValue(null),
  ProviderHealth: { init: vi.fn().mockResolvedValue({ close: vi.fn() }) },
  setProviderHealth: vi.fn(),
}));

vi.mock("./services/metrics/recorder.js", () => ({
  getMetricsRecorder: vi.fn().mockReturnValue(null),
}));

vi.mock("./services/secrets.js", () => ({
  isSecretsConfigured: vi.fn().mockReturnValue(true),
  resolveVaultSecrets: vi.fn().mockResolvedValue({}),
  getSecret: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./services/gtfs/catalog.js", () => ({
  searchCatalog: vi.fn().mockResolvedValue([]),
}));

vi.mock("./services/gtfs/index.js", () => ({
  gtfsManager: { list: vi.fn().mockReturnValue([]) },
}));

vi.mock("./services/gtfs/queries.js", () => ({}));

vi.mock("./utils/require-auth.js", () => ({
  requireAuth: vi.fn().mockImplementation(async () => {
    const { httpError } = await import("@openmapx/integration-framework");
    throw httpError(401, "Authentication required");
  }),
}));

vi.mock("@openmapx/poi-source-registry", () => ({
  registerPoiSources: vi.fn(),
}));

import {
  getAllIntegrations,
  getIntegration,
  initIntegrations,
  reloadIntegrations,
  shutdownIntegrations,
} from "./integration-host.js";
import { isSecretsConfigured } from "./services/secrets.js";

// Helper: build a minimal Fastify instance suitable for testing.
function makeApp(): FastifyInstance {
  return Fastify({ logger: false });
}

// Clear module-level state (the integration map, route list, _fastify ref) by
// shutting down after every test so tests don't bleed into each other.
afterEach(async () => {
  try {
    await shutdownIntegrations();
  } catch {
    // If the host was never initialized, shutdownIntegrations may throw or be
    // a no-op — either is fine for cleanup.
  }
  // Reset the fixture setup-order tracker
  globalThis.__fixtureSetupOrder = undefined;
  // clearAllMocks resets call history but preserves mockReturnValue / mockResolvedValue
  // implementations so subsequent tests don't see undefined from mocked dependencies.
  vi.clearAllMocks();
  // Restore secrets mock to default (configured = true) in case a test changed it.
  vi.mocked(isSecretsConfigured).mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// Step 2: Loader tests
// ---------------------------------------------------------------------------

describe("initIntegrations — loader", () => {
  it("loads alpha and beta from the fixtures directory", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    const all = getAllIntegrations();
    const ids = all.map((i) => i.id);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
  });

  it("getIntegration returns the loaded alpha integration", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    const alpha = getIntegration("alpha");
    expect(alpha).toBeDefined();
    expect(alpha?.id).toBe("alpha");
    expect(alpha?.enabled).toBe(true);
  });

  it("respects topological order: alpha setup ran before beta", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    const order = globalThis.__fixtureSetupOrder ?? [];
    const alphaIdx = order.indexOf("alpha");
    const betaIdx = order.indexOf("beta");
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).toBeLessThan(betaIdx);
  });

  it("skips the broken fixture and warns via the fastify logger", async () => {
    const warnMock = vi.fn();
    const app = makeApp();
    // Patch the fastify logger before initIntegrations runs.
    // biome-ignore lint/suspicious/noExplicitAny: test-only log patch
    (app as any).log = {
      info: vi.fn(),
      warn: warnMock,
      error: vi.fn(),
      debug: vi.fn(),
    };

    await initIntegrations(app, [FIXTURES_DIR]);

    // The broken fixture uses id "BROKEN" (uppercase), which violates the
    // INTEGRATION_ID_REGEX slug constraint and fails validateManifest.
    expect(getIntegration("BROKEN")).toBeUndefined();
    // The host must have warned about the broken manifest.
    const warnCalls = warnMock.mock.calls.flat().join(" ");
    expect(warnCalls).toMatch(/BROKEN|skip/i);
  });

  it("secret-needer loads when OPENMAPX_SECRETS_KEY is configured", async () => {
    // Confirm that the fixture directory containing secret-needer loads without
    // error when isSecretsConfigured returns true (the default in this suite).
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    expect(getAllIntegrations().some((i) => i.id === "secret-needer")).toBe(true);
  });

  it("throws at boot when a manifest declares vault secrets but OPENMAPX_SECRETS_KEY is not set", async () => {
    vi.mocked(isSecretsConfigured).mockReturnValue(false);

    const app = makeApp();

    await expect(initIntegrations(app, [FIXTURES_DIR])).rejects.toThrow(
      /OPENMAPX_SECRETS_KEY is not set/,
    );
  });
});

// ---------------------------------------------------------------------------
// Step 3: Route dispatch tests
// ---------------------------------------------------------------------------

describe("initIntegrations — route dispatch", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);
  });

  it("dispatches GET /api/integrations/alpha/hello → 200 with fixture payload", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/alpha/hello",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ integration: "alpha", message: "hello" });
  });

  it("returns 404 for a path that matches no integration route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/alpha/no-such-route",
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for an integration id that is not loaded", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/nonexistent/hello",
    });

    expect(res.statusCode).toBe(404);
  });

  it("decodes :param segments and passes them to the handler", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/alpha/greet/World",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ greeting: "hello World" });
  });

  it("URL-encoded param is decoded before the handler receives it", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/alpha/greet/Hello%20World",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ greeting: "hello Hello World" });
  });

  it("no-send guard: handler that returns without sending → 500 with expected error message", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/alpha/no-send",
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      error: "Integration handler produced no response",
    });
  });
});

// ---------------------------------------------------------------------------
// Step 4: Reload and shutdown tests
// ---------------------------------------------------------------------------

describe("reloadIntegrations", () => {
  it("after reload getAllIntegrations still returns both fixtures", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    const result = await reloadIntegrations();
    expect(result.message).toBe("Integrations reloaded");

    const ids = getAllIntegrations().map((i) => i.id);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
  });

  it("after reload routes still dispatch correctly (idempotence)", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    await reloadIntegrations();

    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/alpha/hello",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ integration: "alpha" });
  });
});

describe("shutdownIntegrations", () => {
  it("completes without throwing", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    await expect(shutdownIntegrations()).resolves.toBeUndefined();
  });

  it("after shutdown getAllIntegrations returns an empty array", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    await shutdownIntegrations();

    expect(getAllIntegrations()).toHaveLength(0);
  });
});
