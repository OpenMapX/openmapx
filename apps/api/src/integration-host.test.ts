import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
/**
 * Characterization tests for integration-host.ts — loader, route dispatch, and
 * reload/shutdown. These tests pin observable behavior so plan-012 refactors
 * can prove they preserved it.
 *
 * All tests exercise only the public API; no internals are imported or patched.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { getPlaceResolver, registerPlaceResolver } from "@openmapx/place-ids";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getIntegrationHealthMocks,
  createIntegrationHostTestApp as makeApp,
} from "./__tests__/support/integration-host-environment.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync),
  };
});

// The fixtures directory that contains our test integrations.
// import.meta.url points to this file: apps/api/src/integration-host.test.ts
// One level up is apps/api/src/, then __tests__/fixtures/integrations.
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "../__tests__/fixtures/integrations");

import {
  getAllIntegrations,
  getIntegration,
  getIntegrationProviders,
  initIntegrations,
  reloadIntegrations,
  shutdownIntegrations,
} from "./integration-host.js";
import { registerIntegrationRoute, setIntegrationRouteRateLimits } from "./integration-routes.js";
import { makeRateLimitTierHook, type RateLimitTiers } from "./server-wiring.js";
import { isSecretsConfigured } from "./services/secrets.js";
import { resolveRequiresForIntegration } from "./services/service-registry.js";
import { RateLimiter } from "./utils/rate-limit.js";

const integrationHealthMocks = getIntegrationHealthMocks();

function writeTestIntegration(
  root: string,
  directoryName: string,
  manifest: Record<string, unknown>,
): string {
  const directory = join(root, directoryName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  return directory;
}

// Clear module-level state (the integration map, route list, _fastify ref) by
// shutting down after every test so tests don't bleed into each other.
afterEach(async () => {
  setIntegrationRouteRateLimits(null);
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

describe("integration route rate tiers", () => {
  it("uses exactly the declared tier and stops before the handler on 429", async () => {
    const publicLimit = vi.fn(async () => undefined);
    const expensiveLimit = vi.fn(async (_request, reply) => {
      reply.status(429).send({ error: "limited" });
    });
    const tileLimit = vi.fn(async () => undefined);
    setIntegrationRouteRateLimits({
      public: publicLimit,
      expensive: expensiveLimit,
      tile: tileLimit,
    });
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    expect((await app.inject("/api/integrations/alpha/tier-public")).statusCode).toBe(200);
    const limited = await app.inject("/api/integrations/alpha/tier-expensive");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "limited" });
    expect((await app.inject("/api/integrations/alpha/tier-tile")).statusCode).toBe(200);
    expect(publicLimit).toHaveBeenCalledTimes(1);
    expect(expensiveLimit).toHaveBeenCalledTimes(1);
    expect(tileLimit).toHaveBeenCalledTimes(1);
  });
});

describe("host and dispatcher request tier ownership", () => {
  function installTiers(app: FastifyInstance, max = 2) {
    const buckets = {
      public: new RateLimiter({ max, windowMs: 60_000 }),
      expensive: new RateLimiter({ max, windowMs: 60_000 }),
      tile: new RateLimiter({ max, windowMs: 60_000 }),
    };
    const tiers: RateLimitTiers = {
      public: buckets.public.preHandler(),
      expensive: buckets.expensive.preHandler(),
      tile: buckets.tile.preHandler(),
      auth: vi.fn(),
      status: vi.fn(),
    };
    app.addHook("onRequest", makeRateLimitTierHook(tiers));
    setIntegrationRouteRateLimits(tiers);
    app.addHook("onClose", async () => {
      for (const bucket of Object.values(buckets)) bucket.destroy();
    });
  }

  it.each([
    ["/api/integrations", 304],
    ["/api/integrations/health", 200],
    ["/api/integrations/alpha/preview", 304],
  ])(
    "limits host-owned %s before repeated work, including validators and query strings",
    async (url, conditionalStatus) => {
      const app = makeApp();
      installTiers(app);
      await initIntegrations(app, [FIXTURES_DIR]);
      const read = vi.mocked(fs.readFileSync);
      const stat = vi.mocked(fs.statSync);
      try {
        const request = { method: "GET" as const, url, remoteAddress: "198.51.100.40" };
        const first = await app.inject(request);
        expect(first.statusCode).toBe(200);
        const conditional = {
          ...request,
          url: `${url}?fixture=1`,
          headers: {
            "if-none-match": String(first.headers.etag ?? "*"),
            "x-forwarded-for": "127.0.0.1",
          },
        };
        expect((await app.inject(conditional)).statusCode).toBe(conditionalStatus);
        const hashesBefore = vi.mocked(createHash).mock.calls.length;
        const readsBefore = read.mock.calls.length;
        const statsBefore = stat.mock.calls.length;
        const healthReadsBefore =
          integrationHealthMocks.getCachedIntegrationHealthSnapshot.mock.calls.length;
        const exhausted = await app.inject(conditional);
        expect(exhausted.statusCode).toBe(429);
        expect(exhausted.headers["retry-after"]).toBeDefined();
        expect(vi.mocked(createHash).mock.calls.length).toBe(hashesBefore);
        expect(read.mock.calls.length).toBe(readsBefore);
        expect(stat.mock.calls.length).toBe(statsBefore);
        expect(integrationHealthMocks.getCachedIntegrationHealthSnapshot.mock.calls.length).toBe(
          healthReadsBefore,
        );
      } finally {
        await app.close();
      }
    },
  );

  it.each([
    ["public", false],
    ["expensive", false],
    ["tile", false],
    ["public", true],
    ["expensive", true],
    ["tile", true],
  ] as const)(
    "charges actual dispatcher requests exactly once to %s (root route: %s)",
    async (tier, rootRoute) => {
      const app = makeApp();
      installTiers(app);
      app.get("/api/floor", async () => ({ ok: true }));
      await initIntegrations(app, [FIXTURES_DIR]);
      if (rootRoute) {
        registerIntegrationRoute(
          "alpha",
          "GET",
          "/",
          async (_request, reply) => {
            reply.send({ invoked: true });
          },
          { rateLimitTier: tier },
        );
      }
      try {
        const request = {
          method: "GET" as const,
          url: rootRoute
            ? "/api/integrations/alpha?fixture=1"
            : `/api/integrations/alpha/tier-${tier}?fixture=1`,
          remoteAddress: "198.51.100.41",
        };
        for (let i = 0; i < 2; i++) {
          const response = await app.inject(request);
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ invoked: true });
        }
        expect((await app.inject(request)).statusCode).toBe(429);
        const floorRequest = { ...request, url: "/api/floor" };
        if (tier === "public") {
          expect((await app.inject(floorRequest)).statusCode).toBe(429);
        } else {
          expect((await app.inject(floorRequest)).statusCode).toBe(200);
          expect((await app.inject(floorRequest)).statusCode).toBe(200);
          expect((await app.inject(floorRequest)).statusCode).toBe(429);
        }
      } finally {
        await app.close();
      }
    },
  );

  it.each(["/api/integrations", "/api/integrations/health", "/api/integrations/alpha/preview"])(
    "preserves the loopback exemption for host-owned %s",
    async (url) => {
      const app = makeApp();
      installTiers(app, 1);
      await initIntegrations(app, [FIXTURES_DIR]);
      try {
        for (let i = 0; i < 3; i++) {
          expect((await app.inject({ url, remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
        }
      } finally {
        await app.close();
      }
    },
  );
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

  it.each(["built-in-first", "community-first"] as const)(
    "prefers a built-in integration over a colliding community integration (%s)",
    async (order) => {
      const parent = mkdtempSync(join(tmpdir(), "omx-integration-id-collision-"));
      const builtInRoot = join(parent, "built-in");
      const communityRoot = join(parent, "community");
      const builtInDirectory = writeTestIntegration(builtInRoot, "trusted", {
        id: "shared-identity",
        name: "Trusted built-in",
        version: "1.0.0",
        licensing: licensingFromDeclaration("MIT", undefined),
        domains: ["knowledge"],
        quality: "built-in",
      });
      writeTestIntegration(communityRoot, "untrusted", {
        id: "shared-identity",
        name: "Untrusted community",
        version: "1.0.0",
        licensing: licensingFromDeclaration("MIT", undefined),
        domains: ["knowledge"],
        quality: "community",
        dependencies: ["missing-community-dependency"],
      });
      const builtIn = { directory: builtInRoot, isBuiltIn: true };
      const community = { directory: communityRoot, isBuiltIn: false };
      const app = makeApp();

      try {
        await initIntegrations(
          app,
          order === "built-in-first" ? [builtIn, community] : [community, builtIn],
        );

        const loaded = getIntegration("shared-identity");
        expect(loaded).toMatchObject({ directory: builtInDirectory, isBuiltIn: true });
        expect(loaded?.manifest.name).toBe("Trusted built-in");
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it("ignores secret requirements declared only by a colliding community integration", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omx-integration-secret-collision-"));
    const builtInRoot = join(parent, "built-in");
    const communityRoot = join(parent, "community");
    const builtInDirectory = writeTestIntegration(builtInRoot, "trusted", {
      id: "shared-secret-identity",
      name: "Trusted built-in",
      version: "1.0.0",
      licensing: licensingFromDeclaration("MIT", undefined),
      domains: ["knowledge"],
      quality: "built-in",
    });
    writeTestIntegration(communityRoot, "untrusted", {
      id: "shared-secret-identity",
      name: "Untrusted community",
      version: "1.0.0",
      licensing: licensingFromDeclaration("MIT", undefined),
      domains: ["knowledge"],
      quality: "community",
      configSchema: {
        properties: {
          apiKey: {
            type: "string",
            "x-openmapx-secret": true,
          },
        },
      },
    });
    vi.mocked(isSecretsConfigured).mockReturnValue(false);
    const app = makeApp();

    try {
      await initIntegrations(app, [
        { directory: builtInRoot, isBuiltIn: true },
        { directory: communityRoot, isBuiltIn: false },
      ]);

      expect(getIntegration("shared-secret-identity")).toMatchObject({
        directory: builtInDirectory,
        isBuiltIn: true,
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("keeps the first integration when duplicate identities have the same trust", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omx-same-trust-duplicate-"));
    const firstRoot = join(parent, "first");
    const secondRoot = join(parent, "second");
    const firstDirectory = writeTestIntegration(firstRoot, "first", {
      id: "duplicate-community",
      name: "First community",
      version: "1.0.0",
      licensing: licensingFromDeclaration("MIT", undefined),
      domains: ["knowledge"],
      quality: "community",
    });
    writeTestIntegration(secondRoot, "second", {
      id: "duplicate-community",
      name: "Second community",
      version: "1.0.0",
      licensing: licensingFromDeclaration("MIT", undefined),
      domains: ["knowledge"],
      quality: "community",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = makeApp();

    try {
      await initIntegrations(app, [
        { directory: firstRoot, isBuiltIn: false },
        { directory: secondRoot, isBuiltIn: false },
      ]);

      const loaded = getIntegration("duplicate-community");
      expect(loaded).toMatchObject({ directory: firstDirectory, isBuiltIn: false });
      expect(loaded?.manifest.name).toBe("First community");
      const warningText = warn.mock.calls.flat().join(" ");
      expect(warningText).toContain('duplicate integration id "duplicate-community"');
      expect(warningText).not.toContain(parent);
    } finally {
      warn.mockRestore();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("retains a built-in integration when reload discovers a colliding community identity", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omx-reload-id-collision-"));
    const builtInRoot = join(parent, "built-in");
    const communityRoot = join(parent, "community");
    mkdirSync(communityRoot, { recursive: true });
    const builtInDirectory = writeTestIntegration(builtInRoot, "trusted", {
      id: "reload-identity",
      name: "Trusted built-in",
      version: "1.0.0",
      licensing: licensingFromDeclaration("MIT", undefined),
      domains: ["knowledge"],
      quality: "built-in",
    });
    const app = makeApp();

    try {
      await initIntegrations(app, [
        { directory: builtInRoot, isBuiltIn: true },
        { directory: communityRoot, isBuiltIn: false },
      ]);
      expect(getIntegration("reload-identity")).toMatchObject({
        directory: builtInDirectory,
        isBuiltIn: true,
      });

      writeTestIntegration(communityRoot, "untrusted", {
        id: "reload-identity",
        name: "Untrusted community",
        version: "1.0.0",
        licensing: licensingFromDeclaration("MIT", undefined),
        domains: ["knowledge"],
        quality: "community",
      });
      await reloadIntegrations();

      const loaded = getIntegration("reload-identity");
      expect(loaded).toMatchObject({ directory: builtInDirectory, isBuiltIn: true });
      expect(loaded?.manifest.name).toBe("Trusted built-in");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("discovers, validates, stores, and reloads air-quality providers", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omx-air-quality-provider-"));
    const directory = join(parent, "air-quality-probe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "air-quality-probe",
        version: "1.0.0",
        author: "Test",
        licensing: licensingFromDeclaration("MIT", undefined),
        domains: ["air-quality"],
        quality: "built-in",
        dataSources: [
          {
            sourceId: "official-aq",
            name: "Official AQ",
            url: "https://example.test/data",
            licensing: licensingFromDeclaration("Test", undefined, "Official AQ"),
            providerCountry: "US",
            providerPrivacyUrl: "https://example.test/privacy",
          },
        ],
      }),
    );
    const backend = (priority: number) =>
      [
        "export function setup(ctx) {",
        "  ctx.registerAirQualityProvider({",
        "    id: 'official-aq-provider', sourceIds: ['official-aq'],",
        `    priority: ${priority}, capabilities: new Set(['current', 'pollutants']),`,
        "    coverage: { countries: ['US'] }, getCurrent: async () => [],",
        "  });",
        "}",
      ].join("\n");
    writeFileSync(join(directory, "index.js"), backend(10));
    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(
        getIntegrationProviders<{ priority: number }>("air-quality-probe", "air-quality"),
      ).toMatchObject([{ priority: 10 }]);
      writeFileSync(join(directory, "index.js"), backend(2));
      await reloadIntegrations();
      expect(
        getIntegrationProviders<{ priority: number }>("air-quality-probe", "air-quality"),
      ).toMatchObject([{ priority: 2 }]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("stores parking site providers under the parking-sites key", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omx-parking-site-provider-"));
    const directory = join(parent, "parking-site-probe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "parking-site-probe",
        version: "1.0.0",
        author: "Test",
        licensing: licensingFromDeclaration("MIT", undefined),
        domains: ["data-source"],
        quality: "built-in",
      }),
    );
    writeFileSync(
      join(directory, "index.js"),
      [
        "export function setup(ctx) {",
        "  ctx.registerParkingSiteProvider({",
        "    id: 'probe', coverage: { all: true },",
        "    searchSites: async () => ({ sites: [] }), getSite: async () => null,",
        "  });",
        "}",
      ].join("\n"),
    );
    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(
        getIntegrationProviders<{ id: string }>("parking-site-probe", "parking-sites"),
      ).toMatchObject([{ id: "probe" }]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("stores charging site providers under the charging-sites key", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omx-charging-site-provider-"));
    const directory = join(parent, "charging-site-probe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "charging-site-probe",
        version: "1.0.0",
        author: "Test",
        licensing: licensingFromDeclaration("MIT", undefined),
        domains: ["data-source"],
        quality: "built-in",
      }),
    );
    writeFileSync(
      join(directory, "index.js"),
      [
        "export function setup(ctx) {",
        "  ctx.registerChargingSiteProvider({",
        "    id: 'probe', coverage: { all: true },",
        "    searchSites: async () => ({ sites: [] }), getSite: async () => null,",
        "  });",
        "}",
      ].join("\n"),
    );
    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(
        getIntegrationProviders<{ id: string }>("charging-site-probe", "charging-sites"),
      ).toMatchObject([{ id: "probe" }]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("stores camera providers under the cameras key", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omx-camera-provider-"));
    const directory = join(parent, "camera-probe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "camera-probe",
        version: "1.0.0",
        author: "Test",
        licensing: licensingFromDeclaration("MIT", undefined),
        domains: ["data-source"],
        quality: "built-in",
      }),
    );
    writeFileSync(
      join(directory, "index.js"),
      [
        "export function setup(ctx) {",
        "  ctx.registerCameraProvider({",
        "    id: 'probe', coverage: { all: true },",
        "    searchCameras: async () => ({ cameras: [] }), getCamera: async () => null,",
        "  });",
        "}",
      ].join("\n"),
    );
    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(getIntegrationProviders<{ id: string }>("camera-probe", "cameras")).toMatchObject([
        { id: "probe" },
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("stores message-sign providers under the message-signs key", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omx-sign-provider-"));
    const directory = join(parent, "sign-probe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "sign-probe",
        version: "1.0.0",
        author: "Test",
        licensing: licensingFromDeclaration("MIT", undefined),
        domains: ["data-source"],
        quality: "built-in",
      }),
    );
    writeFileSync(
      join(directory, "index.js"),
      [
        "export function setup(ctx) {",
        "  ctx.registerMessageSignProvider({",
        "    id: 'probe', coverage: { all: true },",
        "    searchSigns: async () => ({ signs: [] }), getSign: async () => null,",
        "  });",
        "}",
      ].join("\n"),
    );
    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(getIntegrationProviders<{ id: string }>("sign-probe", "message-signs")).toMatchObject([
        { id: "probe" },
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each([
    ["registerRoadWeatherProvider", "road-weather", "searchStations", "getStation"],
    ["registerServiceVehicleProvider", "service-vehicles", "searchVehicles", "getVehicle"],
    ["registerBorderCrossingProvider", "border-crossings", "searchCrossings", "getCrossing"],
  ])("%s stores its providers under the %s key", async (registrar, key, search, get) => {
    const parent = mkdtempSync(join(tmpdir(), "omx-conditions-provider-"));
    const directory = join(parent, "conditions-probe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "conditions-probe",
        version: "1.0.0",
        author: "Test",
        licensing: licensingFromDeclaration("MIT", undefined),
        domains: ["data-source"],
        quality: "built-in",
      }),
    );
    writeFileSync(
      join(directory, "index.js"),
      [
        "export function setup(ctx) {",
        `  ctx.${registrar}({`,
        "    id: 'probe', coverage: { all: true },",
        `    ${search}: async () => ({}), ${get}: async () => null,`,
        "  });",
        "}",
      ].join("\n"),
    );
    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(getIntegrationProviders<{ id: string }>("conditions-probe", key)).toMatchObject([
        { id: "probe" },
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("stores hazards providers under the hazards key", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omx-hazards-provider-"));
    const directory = join(parent, "hazards-probe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "hazards-probe",
        version: "1.0.0",
        author: "Test",
        licensing: licensingFromDeclaration("MIT", undefined),
        domains: ["data-source"],
        quality: "built-in",
      }),
    );
    writeFileSync(
      join(directory, "index.js"),
      [
        "export function setup(ctx) {",
        "  ctx.registerHazardsProvider({",
        "    id: 'probe', coverage: { all: true },",
        "    getAlerts: async () => ({ alerts: [] }),",
        "    getNaturalHazards: async () => ({ hazards: [] }),",
        "    getFirePixels: async () => ({ pixels: [] }),",
        "    getFireDensity: async () => ({ cells: [], sources: [] }),",
        "  });",
        "}",
      ].join("\n"),
    );
    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(getIntegrationProviders<{ id: string }>("hazards-probe", "hazards")).toMatchObject([
        { id: "probe" },
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("never imports a community backend bundle into the privileged API process", async () => {
    const parent = mkdtempSync(join(tmpdir(), "omx-untrusted-backend-"));
    const integrationDir = join(parent, "untrusted-backend");
    const bundleDir = join(integrationDir, "dist", "backend");
    const frontendBundleDir = join(integrationDir, "dist", "frontend");
    const g = globalThis as Record<string, unknown>;
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(frontendBundleDir, { recursive: true });
    writeFileSync(
      join(integrationDir, "manifest.json"),
      JSON.stringify({
        id: "untrusted-backend",
        version: "1.0.0",
        license: "MIT",
        domains: ["knowledge"],
        backend: { routes: true },
        quality: "community",
      }),
    );
    writeFileSync(
      join(bundleDir, "index.mjs"),
      [
        "globalThis.__untrustedBackendExecuted = true;",
        "export function setup(ctx) {",
        '  ctx.registerRoute("GET", "/owned", (_request, reply) => reply.send({ owned: true }));',
        "}",
      ].join("\n"),
    );
    writeFileSync(join(frontendBundleDir, "index.js"), "globalThis.owned = true;");

    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: false }]);
      expect(g.__untrustedBackendExecuted).toBeUndefined();
      expect(getIntegration("untrusted-backend")).toBeDefined();
      expect(getIntegration("untrusted-backend")?.blockedCode).toBe(true);
      expect((await app.inject("/api/integrations/untrusted-backend/owned")).statusCode).toBe(404);
      expect(
        (await app.inject("/api/integrations/untrusted-backend/bundle/index.js")).statusCode,
      ).toBe(404);

      await reloadIntegrations();
      expect(g.__untrustedBackendExecuted).toBeUndefined();
      expect(getIntegration("untrusted-backend")?.blockedCode).toBe(true);
    } finally {
      delete g.__untrustedBackendExecuted;
      rmSync(parent, { recursive: true, force: true });
    }
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

  it("publishes a cache revision and honors conditional metadata requests", async () => {
    const first = await app.inject({ method: "GET", url: "/api/integrations" });

    expect(first.statusCode).toBe(200);
    expect(first.json().revision).toMatch(/^[a-f0-9]{64}$/);
    expect(first.headers.etag).toBe(`"${first.json().revision}"`);
    expect(first.headers["cache-control"]).toBe("private, no-cache");

    const unchanged = await app.inject({
      method: "GET",
      url: "/api/integrations",
      headers: { "if-none-match": first.headers.etag as string },
    });

    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
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

  it("forwards request headers to the handler, lowercased, unmodified", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/alpha/echo-header",
      headers: { "If-None-Match": '"abc123"' },
    });

    expect(res.statusCode).toBe(200);
    // Fastify/Node lowercase incoming header names regardless of how the
    // client cased them, and pass the value through byte-for-byte —
    // including the quotes an ETag comparison depends on.
    expect(res.json()).toMatchObject({ ifNoneMatch: '"abc123"' });
  });

  it("preserves repeated integration query parameters as arrays", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/alpha/echo-query?lat=1&lat=2&optional=ok",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ query: { lat: ["1", "2"], optional: "ok" } });
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

// Regression guard for the dynamic-import cache-bust used by trusted built-in
// backend code during an in-process reload.
describe("reloadIntegrations — re-imports changed backend code in production", () => {
  it("picks up rewritten trusted backend code on reload (no restart)", async () => {
    const prevEnv = process.env.NODE_ENV;
    const parent = mkdtempSync(join(tmpdir(), "omx-reload-probe-"));
    const intgDir = join(parent, "reload-probe");
    mkdirSync(intgDir, { recursive: true });
    writeFileSync(
      join(intgDir, "manifest.json"),
      JSON.stringify({
        id: "reload-probe",
        version: "1.0.0",
        license: "MIT",
        domains: ["knowledge"],
        backend: { routes: false },
        quality: "built-in",
      }),
    );
    const bundleFile = join(intgDir, "index.js");
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
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
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
    const integrationDir = join(parent, "gate-probe");
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(parent, "gate-probe", "manifest.json"),
      JSON.stringify({
        id: "gate-probe",
        version: "1.0.0",
        license: "MIT",
        domains: ["knowledge"],
        backend: { routes: false },
        quality: "built-in",
      }),
    );
    // Parks inside setup() only when armed; the setup count advances after the
    // park so each reload pass that runs gate-probe is observable.
    writeFileSync(
      join(integrationDir, "index.js"),
      [
        "export async function setup(ctx) {",
        "  const g = globalThis;",
        "  if (g.__omxGateArmed) {",
        "    g.__omxGateArmed = false;",
        "    await new Promise((resolve) => {",
        "      g.__omxGateRelease = resolve;",
        "      if (typeof g.__omxGateEntered === 'function') g.__omxGateEntered();",
        "    });",
        "  }",
        "  g.__omxGateSetupCount = (g.__omxGateSetupCount ?? 0) + 1;",
        "  ctx.onShutdown(async () => {",
        "    g.__omxGateShutdownCount = (g.__omxGateShutdownCount ?? 0) + 1;",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    return parent;
  }

  function writeProcessStateFixture(): string {
    const parent = mkdtempSync(join(tmpdir(), "omx-process-state-probe-"));
    const integrationDir = join(parent, "process-state-probe");
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, "manifest.json"),
      JSON.stringify({
        id: "process-state-probe",
        version: "1.0.0",
        license: "MIT",
        domains: ["knowledge"],
        backend: { routes: false },
        quality: "built-in",
      }),
    );
    writeFileSync(
      join(integrationDir, "index.js"),
      [
        "export async function setup(ctx) {",
        "  const g = globalThis;",
        "  if (typeof g.__omxProcessStateSetup === 'function') g.__omxProcessStateSetup(ctx);",
        "  if (g.__omxProcessStateFail) throw new Error('injected process-state failure');",
        "  if (g.__omxProcessStateGateArmed) {",
        "    g.__omxProcessStateGateArmed = false;",
        "    await new Promise((resolve) => {",
        "      g.__omxProcessStateRelease = resolve;",
        "      if (typeof g.__omxProcessStateEntered === 'function') g.__omxProcessStateEntered();",
        "    });",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    return parent;
  }

  function installProcessStateProbe(g: Record<string, unknown>): () => number {
    let generation = 0;
    g.__omxProcessStateSetup = (ctx: IntegrationContext) => {
      generation += 1;
      const registeredGeneration = generation;
      const previousActiveGeneration = g.__omxActiveProcessStateGeneration;
      const record = (event: string): void => {
        (g.__omxActivationEvents as string[] | undefined)?.push(event);
      };
      registerPlaceResolver("process-state-probe", async () => registeredGeneration);
      ctx.onActivate(
        () => record(`activate:${registeredGeneration}:first`),
        () => record(`rollback:${registeredGeneration}:first`),
      );
      ctx.onActivate(
        () => {
          record(`activate:${registeredGeneration}:second`);
          if (g.__omxProcessStateActivationFail) {
            throw new Error("injected process-state activation failure");
          }
        },
        () => record(`rollback:${registeredGeneration}:second`),
      );
      ctx.onActivate(
        () => record(`activate:${registeredGeneration}:third`),
        () => record(`rollback:${registeredGeneration}:third`),
      );
      ctx.onActivate(
        () => {
          record(`activate:${registeredGeneration}:active`);
          g.__omxActiveProcessStateGeneration = registeredGeneration;
        },
        () => {
          record(`rollback:${registeredGeneration}:active`);
          g.__omxActiveProcessStateGeneration = previousActiveGeneration;
        },
      );
    };
    return () => generation;
  }

  async function resolvedProcessStateGeneration(): Promise<number | null | undefined> {
    return getPlaceResolver<number>("process-state-probe")?.("value", {});
  }

  it("never exposes an empty/partial registry mid-reload and coalesces N callers into one trailing pass", async () => {
    const parent = writeGateFixture();
    const g = globalThis as Record<string, unknown>;
    const app = makeApp();
    try {
      await initIntegrations(app, [FIXTURES_DIR, { directory: parent, isBuiltIn: true }]);
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
      expect(g.__omxGateShutdownCount ?? 0).toBe(0);

      const midResponse = await app.inject({
        method: "GET",
        url: "/api/integrations/alpha/hello",
      });
      expect(midResponse.statusCode).toBe(200);
      expect(midResponse.json()).toMatchObject({ integration: "alpha" });

      // Two more callers arriving during the in-flight pass share ONE trailing pass.
      const p2 = reloadIntegrations();
      const p3 = reloadIntegrations();

      const release = g.__omxGateRelease as () => void;
      delete g.__omxGateRelease;
      release();
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
      if (typeof g.__omxGateRelease === "function") {
        (g.__omxGateRelease as () => void)();
        await Promise.allSettled([reloadIntegrations()]);
      }
      delete g.__omxGateArmed;
      delete g.__omxGateRelease;
      delete g.__omxGateEntered;
      delete g.__omxGateSetupCount;
      delete g.__omxGateShutdownCount;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("keeps place resolvers on the old generation until commit", async () => {
    const parent = writeProcessStateFixture();
    const g = globalThis as Record<string, unknown>;
    const app = makeApp();
    const currentGeneration = installProcessStateProbe(g);
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(currentGeneration()).toBe(1);
      expect(await resolvedProcessStateGeneration()).toBe(1);
      expect(g.__omxActiveProcessStateGeneration).toBe(1);

      g.__omxProcessStateGateArmed = true;
      const entered = new Promise<void>((resolve) => {
        g.__omxProcessStateEntered = resolve;
      });
      const reload = reloadIntegrations();
      await entered;

      expect(currentGeneration()).toBe(2);
      expect(await resolvedProcessStateGeneration()).toBe(1);
      expect(g.__omxActiveProcessStateGeneration).toBe(1);

      (g.__omxProcessStateRelease as () => void)();
      delete g.__omxProcessStateRelease;
      await reload;

      expect(await resolvedProcessStateGeneration()).toBe(2);
      expect(g.__omxActiveProcessStateGeneration).toBe(2);
    } finally {
      if (typeof g.__omxProcessStateRelease === "function") {
        (g.__omxProcessStateRelease as () => void)();
      }
      delete g.__omxProcessStateSetup;
      delete g.__omxProcessStateGateArmed;
      delete g.__omxProcessStateEntered;
      delete g.__omxProcessStateRelease;
      delete g.__omxProcessStateFail;
      delete g.__omxActiveProcessStateGeneration;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("activates cold-start and reload transactions in registration order", async () => {
    const parent = writeProcessStateFixture();
    const g = globalThis as Record<string, unknown>;
    const app = makeApp();
    g.__omxActivationEvents = [];
    installProcessStateProbe(g);
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(g.__omxActivationEvents).toEqual([
        "activate:1:first",
        "activate:1:second",
        "activate:1:third",
        "activate:1:active",
      ]);

      g.__omxActivationEvents = [];
      await reloadIntegrations();

      expect(g.__omxActivationEvents).toEqual([
        "activate:2:first",
        "activate:2:second",
        "activate:2:third",
        "activate:2:active",
      ]);
      expect(g.__omxActiveProcessStateGeneration).toBe(2);
    } finally {
      delete g.__omxActivationEvents;
      delete g.__omxProcessStateSetup;
      delete g.__omxProcessStateActivationFail;
      delete g.__omxActiveProcessStateGeneration;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rolls back immediate cold-start activations when setup later fails", async () => {
    const parent = writeProcessStateFixture();
    const g = globalThis as Record<string, unknown>;
    const app = makeApp();
    g.__omxActivationEvents = [];
    g.__omxProcessStateFail = true;
    installProcessStateProbe(g);
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);

      expect(getIntegration("process-state-probe")?.enabled).toBe(false);
      expect(g.__omxActivationEvents).toEqual([
        "activate:1:first",
        "activate:1:second",
        "activate:1:third",
        "activate:1:active",
        "rollback:1:active",
        "rollback:1:third",
        "rollback:1:second",
        "rollback:1:first",
      ]);
      expect(g.__omxActiveProcessStateGeneration).toBeUndefined();
    } finally {
      delete g.__omxActivationEvents;
      delete g.__omxProcessStateSetup;
      delete g.__omxProcessStateFail;
      delete g.__omxActiveProcessStateGeneration;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rolls back staged place resolvers after setup fails", async () => {
    const parent = writeProcessStateFixture();
    const g = globalThis as Record<string, unknown>;
    const app = makeApp();
    const currentGeneration = installProcessStateProbe(g);
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      g.__omxActivationEvents = [];
      g.__omxProcessStateFail = true;

      await expect(reloadIntegrations()).rejects.toThrow("injected process-state failure");

      expect(currentGeneration()).toBe(2);
      expect(await resolvedProcessStateGeneration()).toBe(1);
      expect(g.__omxActiveProcessStateGeneration).toBe(1);
      expect(g.__omxActivationEvents).toEqual([
        "rollback:2:active",
        "rollback:2:third",
        "rollback:2:second",
        "rollback:2:first",
      ]);
    } finally {
      delete g.__omxProcessStateSetup;
      delete g.__omxProcessStateGateArmed;
      delete g.__omxProcessStateEntered;
      delete g.__omxProcessStateRelease;
      delete g.__omxProcessStateFail;
      delete g.__omxActivationEvents;
      delete g.__omxActiveProcessStateGeneration;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rolls back completed and staged transactions once when activation fails", async () => {
    const parent = writeProcessStateFixture();
    const g = globalThis as Record<string, unknown>;
    const app = makeApp();
    installProcessStateProbe(g);
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      g.__omxActivationEvents = [];
      g.__omxProcessStateActivationFail = true;

      await expect(reloadIntegrations()).rejects.toThrow(
        "injected process-state activation failure",
      );

      expect(g.__omxActivationEvents).toEqual([
        "activate:2:first",
        "activate:2:second",
        "rollback:2:active",
        "rollback:2:third",
        "rollback:2:second",
        "rollback:2:first",
      ]);
      expect(await resolvedProcessStateGeneration()).toBe(1);
      expect(g.__omxActiveProcessStateGeneration).toBe(1);
    } finally {
      delete g.__omxActivationEvents;
      delete g.__omxProcessStateSetup;
      delete g.__omxProcessStateActivationFail;
      delete g.__omxActiveProcessStateGeneration;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("keeps the complete old graph active when staging fails before provider setup", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);
    const before = getAllIntegrations().map((integration) => integration.id);
    vi.mocked(resolveRequiresForIntegration).mockImplementationOnce(() => {
      throw new Error("injected staging failure");
    });

    await expect(reloadIntegrations()).rejects.toThrow("injected staging failure");

    expect(getAllIntegrations().map((integration) => integration.id)).toEqual(before);
    const response = await app.inject({
      method: "GET",
      url: "/api/integrations/alpha/hello",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ integration: "alpha" });
  });

  it("rejects an invalid staged manifest without retiring the valid old generation", async () => {
    const parent = writeGateFixture();
    const manifestPath = join(parent, "gate-probe", "manifest.json");
    const app = makeApp();
    try {
      await initIntegrations(app, [FIXTURES_DIR, { directory: parent, isBuiltIn: true }]);
      expect(getIntegration("gate-probe")).toBeDefined();

      writeFileSync(
        manifestPath,
        JSON.stringify({
          id: "gate-probe",
          version: 7,
          license: "MIT",
          domains: ["knowledge"],
          quality: "built-in",
        }),
      );

      await expect(reloadIntegrations()).rejects.toThrow("manifest validation failed");

      expect(getIntegration("gate-probe")).toBeDefined();
      const response = await app.inject({
        method: "GET",
        url: "/api/integrations/alpha/hello",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ integration: "alpha" });
    } finally {
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
