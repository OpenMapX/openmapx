/**
 * Characterization tests for integration-host.ts — loader, route dispatch, and
 * reload/shutdown. These tests pin observable behavior so plan-012 refactors
 * can prove they preserved it.
 *
 * All tests exercise only the public API; no internals are imported or patched.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const integrationHealthMocks = vi.hoisted(() => ({
  executeAllIntegrationHealthChecks: vi.fn().mockResolvedValue([]),
  getCachedIntegrationHealthSnapshot: vi.fn().mockReturnValue({
    updatedAt: null,
    results: [],
  }),
}));

vi.mock("./services/integration-health.js", () => integrationHealthMocks);

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

  it("serves cached integration health without running a provider sweep", async () => {
    integrationHealthMocks.getCachedIntegrationHealthSnapshot.mockReturnValueOnce({
      updatedAt: Date.parse("2026-07-28T08:00:00.000Z"),
      results: [
        {
          id: "alpha",
          name: "Alpha",
          category: "Other",
          url: "https://example.com/health",
          status: "up",
        },
      ],
    });
    integrationHealthMocks.executeAllIntegrationHealthChecks.mockClear();

    const res = await app.inject({ method: "GET", url: "/api/integrations/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      timestamp: "2026-07-28T08:00:00.000Z",
      services: [
        {
          id: "alpha",
          name: "Alpha",
          category: "Other",
          url: "https://example.com/health",
          status: "up",
        },
      ],
    });
    expect(integrationHealthMocks.getCachedIntegrationHealthSnapshot).toHaveBeenCalledOnce();
    expect(integrationHealthMocks.executeAllIntegrationHealthChecks).not.toHaveBeenCalled();
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

describe("integration layer previews", () => {
  it("serves a built-in preview with security and revalidation headers", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);
    const expected = readFileSync(join(FIXTURES_DIR, "alpha", "preview.svg"), "utf-8");

    const response = await app.inject({ method: "GET", url: "/api/integrations/alpha/preview" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(expected);
    expect(response.headers["content-type"]).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(response.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);

    const revalidated = await app.inject({
      method: "GET",
      url: "/api/integrations/alpha/preview",
      headers: { "if-none-match": response.headers.etag as string },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body).toBe("");
  });

  it("returns 404 when the integration or preview declaration is missing", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    const undeclared = await app.inject({ method: "GET", url: "/api/integrations/beta/preview" });
    expect(undeclared.statusCode).toBe(404);
    const unknown = await app.inject({ method: "GET", url: "/api/integrations/unknown/preview" });
    expect(unknown.statusCode).toBe(404);
  });

  it("serves the same preview for a community integration", async () => {
    const app = makeApp();
    await initIntegrations(app, [{ directory: FIXTURES_DIR, isBuiltIn: false }]);

    const response = await app.inject({ method: "GET", url: "/api/integrations/alpha/preview" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(response.body).toBe(readFileSync(join(FIXTURES_DIR, "alpha", "preview.svg"), "utf-8"));
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

// Regression guard for the prod cache-bust: a store update of a community
// integration whose bundle path is unchanged must take effect on reload WITHOUT
// restarting app-api. Runs under NODE_ENV=production specifically — the old
// behavior skipped cache-busting in prod, so the re-import returned the stale
// module and this test would fail.
describe("reloadIntegrations — re-imports changed backend code in production", () => {
  it("picks up a rewritten community bundle on reload (no restart)", async () => {
    const prevEnv = process.env.NODE_ENV;
    const parent = mkdtempSync(join(tmpdir(), "omx-reload-probe-"));
    const intgDir = join(parent, "reload-probe");
    const bundleDir = join(intgDir, "dist", "backend");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(intgDir, "manifest.json"),
      JSON.stringify({
        id: "reload-probe",
        version: "1.0.0",
        license: "MIT",
        domains: ["knowledge"],
        backend: { routes: false },
        quality: "community-verified",
      }),
    );
    const bundleFile = join(bundleDir, "index.mjs");
    // Marker is set at MODULE EVALUATION time, so it only changes if the module
    // is actually re-imported (a fresh URL) — not merely re-`setup()`-ed.
    const writeBundle = (marker: string) =>
      writeFileSync(
        bundleFile,
        `globalThis.__reloadProbeVersion = ${JSON.stringify(marker)};\nexport function setup() {}\n`,
      );

    const app = makeApp();
    const g = globalThis as Record<string, unknown>;
    try {
      process.env.NODE_ENV = "production";

      writeBundle("v1");
      await initIntegrations(app, [{ directory: parent, isBuiltIn: false }]);
      expect(g.__reloadProbeVersion).toBe("v1");

      // Rewrite the bundle. Different content AND length so the mtime+size key
      // changes even on a coarse-mtime filesystem.
      writeBundle("v2-rewritten-and-longer");
      await reloadIntegrations();
      expect(g.__reloadProbeVersion).toBe("v2-rewritten-and-longer");
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
      rmSync(parent, { recursive: true, force: true });
      delete g.__reloadProbeVersion;
    }
  });
});

// The reload mutex + atomic contents-swap are exercised end-to-end through the
// public reloadIntegrations, using a gate fixture whose setup() parks on a
// test-controlled promise so we can inspect the registry mid-reload.
describe("reloadIntegrations — concurrency and mid-reload visibility", () => {
  function writeGateFixture(): string {
    const parent = mkdtempSync(join(tmpdir(), "omx-gate-probe-"));
    const bundleDir = join(parent, "gate-probe", "dist", "backend");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(parent, "gate-probe", "manifest.json"),
      JSON.stringify({
        id: "gate-probe",
        version: "1.0.0",
        license: "MIT",
        domains: ["knowledge"],
        backend: { routes: false },
        quality: "community-verified",
      }),
    );
    // Parks inside setup() only when armed; the setup count advances after the
    // park so each reload pass that runs gate-probe is observable.
    writeFileSync(
      join(bundleDir, "index.mjs"),
      [
        "export async function setup() {",
        "  const g = globalThis;",
        "  if (g.__omxGateArmed) {",
        "    g.__omxGateArmed = false;",
        "    await new Promise((resolve) => {",
        "      g.__omxGateRelease = resolve;",
        "      if (typeof g.__omxGateEntered === 'function') g.__omxGateEntered();",
        "    });",
        "  }",
        "  g.__omxGateSetupCount = (g.__omxGateSetupCount ?? 0) + 1;",
        "}",
        "",
      ].join("\n"),
    );
    return parent;
  }

  it("never exposes an empty/partial registry mid-reload and coalesces N callers into one trailing pass", async () => {
    const parent = writeGateFixture();
    const g = globalThis as Record<string, unknown>;
    const app = makeApp();
    try {
      await initIntegrations(app, [FIXTURES_DIR, { directory: parent, isBuiltIn: false }]);
      expect(g.__omxGateSetupCount).toBe(1);

      // Arm so the next reload parks inside gate-probe's setup, mid-rebuild.
      g.__omxGateArmed = true;
      const entered = new Promise<void>((resolve) => {
        g.__omxGateEntered = resolve;
      });

      const p1 = reloadIntegrations();
      await entered;

      // While the rebuild is parked, the OLD registry is still fully visible —
      // under the previous clear-then-fill this would be empty/partial.
      const midIds = getAllIntegrations().map((i) => i.id);
      expect(midIds).toContain("alpha");
      expect(midIds).toContain("beta");
      expect(midIds).toContain("gate-probe");

      // Two more callers arriving during the in-flight pass share ONE trailing pass.
      const p2 = reloadIntegrations();
      const p3 = reloadIntegrations();

      (g.__omxGateRelease as () => void)();
      const results = await Promise.all([p1, p2, p3]);
      for (const r of results) expect(r.message).toBe("Integrations reloaded");

      // init(1) + in-flight reload(1) + exactly one shared trailing pass(1).
      // A naive per-caller queue would give 4; pure coalescing would give 2.
      expect(g.__omxGateSetupCount).toBe(3);

      const finalIds = getAllIntegrations().map((i) => i.id);
      expect(finalIds).toContain("alpha");
      expect(finalIds).toContain("beta");
      expect(finalIds).toContain("gate-probe");
    } finally {
      delete g.__omxGateArmed;
      delete g.__omxGateRelease;
      delete g.__omxGateEntered;
      delete g.__omxGateSetupCount;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("runs two overlapping gateless reloads and keeps routes dispatching", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    const [r1, r2] = await Promise.all([reloadIntegrations(), reloadIntegrations()]);
    expect(r1.reloaded).toBeGreaterThanOrEqual(2);
    expect(r2.reloaded).toBeGreaterThanOrEqual(2);

    const ids = getAllIntegrations().map((i) => i.id);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");

    const res = await app.inject({ method: "GET", url: "/api/integrations/alpha/hello" });
    expect(res.statusCode).toBe(200);
  });
});
