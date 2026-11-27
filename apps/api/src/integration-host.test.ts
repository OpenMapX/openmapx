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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectOrderedProviders,
  effectiveProviderOrder,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import { getPlaceResolver, registerPlaceResolver } from "@openmapx/place-ids";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAttentionMocks,
  getDisabledExtensionMocks,
  getExtensionMigrationMocks,
  getIntegrationHealthMocks,
  getSubjectDataMocks,
  getTaskRunMocks,
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
  failedIntegrationLoads,
  getAllIntegrations,
  getIntegration,
  getIntegrationProviders,
  getIntegrationsByDomain,
  getProviderOrder,
  heldBackIntegrationLoads,
  initIntegrations,
  isEnabledIntegrationScheme,
  markSafeModeRecordsFailed,
  reloadIntegrations,
  setCompatibilityResolver,
  setDisabledExtensionResolver,
  shutdownIntegrations,
  startIntegrationHealthRefresh,
  stopIntegrationHealthRefresh,
} from "./integration-host.js";
import { registerIntegrationRoute, setIntegrationRouteRateLimits } from "./integration-routes.js";
import { currentIntegrationScope } from "./integration-scope.js";
import { createExtensionSubjectData } from "./privacy/extension-subject-data.js";
import { processLogger } from "./process-logger";
import { beginBoot, initSafeMode } from "./safe-mode.js";
import { makeRateLimitTierHook, type RateLimitTiers } from "./server-wiring.js";
import { getAttributionIndex } from "./services/attribution/index.js";
import { secretsKeyProblem } from "./services/secrets.js";
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
  // Restore secrets mock to default (a usable key) in case a test changed it.
  vi.mocked(secretsKeyProblem).mockReturnValue(null);
});

describe("integration route rate tiers", () => {
  it("uses exactly the declared tier and stops before the handler on 429", async () => {
    const publicLimit = vi.fn(async () => undefined);
    const expensiveLimit = vi.fn(async (_request, reply) => {
      reply.status(429).send({ error: "limited" });
    });
    const tileLimit = vi.fn(async () => undefined);
    const typeaheadLimit = vi.fn(async () => undefined);
    setIntegrationRouteRateLimits({
      public: publicLimit,
      expensive: expensiveLimit,
      tile: tileLimit,
      typeahead: typeaheadLimit,
      routing: vi.fn(async () => undefined),
      contribution: vi.fn(async () => undefined),
      enrollment: vi.fn(async () => undefined),
      unmatched: vi.fn(async () => undefined),
    });
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    expect((await app.inject("/api/integrations/alpha/tier-public")).statusCode).toBe(200);
    const limited = await app.inject("/api/integrations/alpha/tier-expensive");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "limited" });
    expect((await app.inject("/api/integrations/alpha/tier-tile")).statusCode).toBe(200);
    expect((await app.inject("/api/integrations/alpha/tier-typeahead")).statusCode).toBe(200);
    expect(typeaheadLimit).toHaveBeenCalledTimes(1);
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
      typeahead: new RateLimiter({ max, windowMs: 60_000 }),
      routing: new RateLimiter({ max, windowMs: 60_000 }),
      contribution: new RateLimiter({ max, windowMs: 60_000 }),
      enrollment: new RateLimiter({ max, windowMs: 60_000 }),
    };
    const tiers: RateLimitTiers = {
      public: buckets.public.preHandler(),
      expensive: buckets.expensive.preHandler(),
      tile: buckets.tile.preHandler(),
      typeahead: buckets.typeahead.preHandler(),
      routing: buckets.routing.preHandler(),
      contribution: buckets.contribution.preHandler(),
      enrollment: buckets.enrollment.preHandler(),
      auth: vi.fn(),
      integrationIngress: vi.fn(),
      status: vi.fn(),
      unmatched: vi.fn(),
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

  it("rejects exhausted body ingress before parsing, matching, and the declared tier", async () => {
    const app = makeApp();
    const ingress = new RateLimiter({ max: 1, windowMs: 60_000 });
    const parseBody = vi.fn((_request, body, done) => done(null, body));
    const latePublic = vi.fn(async () => undefined);
    const unexpectedTier = vi.fn(async () => {
      throw new Error("Wrong rate-limit tier");
    });
    const handler = vi.fn(async (request, reply) => {
      reply.send({ body: request.body });
    });
    const tiers: RateLimitTiers = {
      auth: unexpectedTier,
      tile: unexpectedTier,
      expensive: unexpectedTier,
      integrationIngress: ingress.preHandler(),
      status: unexpectedTier,
      public: latePublic,
      unmatched: unexpectedTier,
      typeahead: unexpectedTier,
      routing: unexpectedTier,
      contribution: unexpectedTier,
      enrollment: unexpectedTier,
    };
    app.addContentTypeParser("application/x-integration-probe", { parseAs: "string" }, parseBody);
    app.addHook("onRequest", makeRateLimitTierHook(tiers));
    setIntegrationRouteRateLimits(tiers);
    await initIntegrations(app, [FIXTURES_DIR]);
    registerIntegrationRoute("alpha", "POST", "/body-probe", handler);

    const request = {
      method: "POST" as const,
      remoteAddress: "198.51.100.42",
      headers: { "content-type": "application/x-integration-probe" },
      payload: "synthetic body",
    };
    try {
      const admitted = await app.inject({
        ...request,
        url: "/api/integrations/alpha/body-probe",
      });
      expect(admitted.statusCode).toBe(200);
      expect(admitted.json()).toEqual({ body: "synthetic body" });
      expect(parseBody).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(latePublic).toHaveBeenCalledTimes(1);

      for (const attempt of [
        { ...request, url: "/api/integrations/alpha/body-probe" },
        { ...request, url: "/api/integrations/missing/body-probe" },
        { ...request, url: "/api/integrations/alpha/missing" },
        {
          method: "POST" as const,
          url: "/api/integrations/alpha/body-probe",
          remoteAddress: "198.51.100.42",
          headers: { "content-type": "application/json" },
          payload: "{",
        },
      ]) {
        const rejected = await app.inject(attempt);
        expect(rejected.statusCode).toBe(429);
        expect(rejected.json()).toMatchObject({
          error: "Too many requests",
          retryAfter: expect.any(Number),
        });
        expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
      }
      expect(parseBody).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(latePublic).toHaveBeenCalledTimes(1);
      expect(unexpectedTier).not.toHaveBeenCalled();
    } finally {
      await app.close();
      ingress.destroy();
    }
  });

  it.each([
    ["public", false],
    ["expensive", false],
    ["tile", false],
    ["typeahead", false],
    ["routing", false],
    ["public", true],
    ["expensive", true],
    ["tile", true],
    ["typeahead", true],
    ["routing", true],
    ["contribution", true],
    ["enrollment", true],
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
        platform: "1.0",
        domains: ["knowledge"],
        quality: "built-in",
      });
      writeTestIntegration(communityRoot, "untrusted", {
        id: "shared-identity",
        name: "Untrusted community",
        version: "1.0.0",
        platform: "1.0",
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
      platform: "1.0",
      domains: ["knowledge"],
      quality: "built-in",
    });
    writeTestIntegration(communityRoot, "untrusted", {
      id: "shared-secret-identity",
      name: "Untrusted community",
      version: "1.0.0",
      platform: "1.0",
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
    vi.mocked(secretsKeyProblem).mockReturnValue("The secrets key is not configured");
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
      platform: "1.0",
      domains: ["knowledge"],
      quality: "community",
    });
    writeTestIntegration(secondRoot, "second", {
      id: "duplicate-community",
      name: "Second community",
      version: "1.0.0",
      platform: "1.0",
      domains: ["knowledge"],
      quality: "community",
    });
    const warn = vi.spyOn(processLogger, "warn").mockImplementation(() => undefined);
    const app = makeApp();

    try {
      await initIntegrations(app, [
        { directory: firstRoot, isBuiltIn: false },
        { directory: secondRoot, isBuiltIn: false },
      ]);

      const loaded = getIntegration("duplicate-community");
      expect(loaded).toMatchObject({ directory: firstDirectory, isBuiltIn: false });
      expect(loaded?.manifest.name).toBe("First community");
      const warningText = JSON.stringify(warn.mock.calls);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ integrationId: "duplicate-community" }),
        expect.stringContaining("duplicate integration id"),
      );
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
      platform: "1.0",
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
        platform: "1.0",
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

  it.each([
    ["stores a valid provider under landmark-models", "landmark-probe", "probe", 1],
    ["rejects undeclared sources", "landmark-probe", "other", 0],
    ["rejects a provider id other than the integration id", "someone-else", "probe", 0],
  ])("registerLandmarkModelProvider %s", async (_label, providerId, sourceId, expected) => {
    const parent = mkdtempSync(join(tmpdir(), "omx-landmark-provider-"));
    const directory = join(parent, "landmark-probe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "landmark-probe",
        version: "1.0.0",
        author: "Test",
        platform: "1.0",
        domains: ["landmark-models"],
        quality: "built-in",
        dataSources: [
          {
            sourceId: "probe",
            name: "Probe",
            url: "https://example.test/data",
            licensing: licensingFromDeclaration("Test", undefined, "Probe"),
            providerCountry: "US",
            providerPrivacyUrl: "https://example.test/privacy",
          },
        ],
      }),
    );
    writeFileSync(
      join(directory, "index.js"),
      [
        "export function setup(ctx) {",
        "  ctx.registerLandmarkModelProvider({",
        `    id: '${providerId}', sourceIds: ['${sourceId}'],`,
        "    snapshot: () => null, fetchModelGzip: async () => ({ status: 'unlisted' }),",
        "  });",
        "}",
      ].join("\n"),
    );
    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(getIntegrationProviders("landmark-probe", "landmark-models")).toHaveLength(expected);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each([
    ["stores a data source whose id is a valid place-id scheme", "probe-stations", 1],
    ["rejects a data source whose id starts with a digit", "3d-models", 0],
  ])("registerMobilityDataSource %s", async (_label, providerId, expected) => {
    const parent = mkdtempSync(join(tmpdir(), "omx-data-source-provider-"));
    const directory = join(parent, "data-source-probe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "data-source-probe",
        version: "1.0.0",
        author: "Test",
        platform: "1.0",
        domains: ["data-source"],
        quality: "built-in",
      }),
    );
    writeFileSync(
      join(directory, "index.js"),
      [
        "export function setup(ctx) {",
        `  ctx.registerMobilityDataSource({ id: '${providerId}', meta: {}, attribution: [],`,
        "    getFilters: async () => [], search: async () => ({}), getDetail: async () => ({}) });",
        "}",
      ].join("\n"),
    );
    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(getIntegrationProviders("data-source-probe", "data-source")).toHaveLength(expected);
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
        platform: "1.0",
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

  it.each([
    [
      "registerParkingSiteProvider",
      "parking-sites",
      "searchSites: async () => ({ sites: [] }), getSite: async () => null",
    ],
    [
      "registerChargingSiteProvider",
      "charging-sites",
      "searchSites: async () => ({ sites: [] }), getSite: async () => null",
    ],
    [
      "registerCameraProvider",
      "cameras",
      "searchCameras: async () => ({ cameras: [] }), getCamera: async () => null",
    ],
    [
      "registerMessageSignProvider",
      "message-signs",
      "searchSigns: async () => ({ signs: [] }), getSign: async () => null",
    ],
    [
      "registerRoadWeatherProvider",
      "road-weather",
      "searchStations: async () => ({}), getStation: async () => null",
    ],
    [
      "registerServiceVehicleProvider",
      "service-vehicles",
      "searchVehicles: async () => ({}), getVehicle: async () => null",
    ],
    [
      "registerBorderCrossingProvider",
      "border-crossings",
      "searchCrossings: async () => ({}), getCrossing: async () => null",
    ],
    [
      "registerHazardsProvider",
      "hazards",
      "getAlerts: async () => ({ alerts: [] }), getNaturalHazards: async () => ({ hazards: [] }), getFirePixels: async () => ({ pixels: [] }), getFireDensity: async () => ({ cells: [], sources: [] })",
    ],
  ])("%s stores its providers under the %s key", async (registrar, key, methods) => {
    const parent = mkdtempSync(join(tmpdir(), "omx-domain-provider-"));
    const directory = join(parent, "domain-probe");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "domain-probe",
        version: "1.0.0",
        author: "Test",
        platform: "1.0",
        domains: ["data-source"],
        quality: "built-in",
      }),
    );
    writeFileSync(
      join(directory, "index.js"),
      `export function setup(ctx) {
      ctx.${registrar}({ id: 'probe', coverage: { all: true }, ${methods} });
    }`,
    );
    const app = makeApp();
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
      expect(getIntegrationProviders<{ id: string }>("domain-probe", key)).toMatchObject([
        { id: "probe" },
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  describe("installed backend code", () => {
    const g = globalThis as Record<string, unknown>;
    let parent: string;
    let installedRoot: string;
    let builtInRoot: string;

    beforeEach(() => {
      parent = mkdtempSync(join(tmpdir(), "omx-installed-backend-"));
      installedRoot = join(parent, "installed");
      builtInRoot = join(parent, "built-in");
      mkdirSync(installedRoot);
      mkdirSync(builtInRoot);
      // Node caches modules per URL for the life of the process, so every test
      // gets its own cache root and bundle bytes naming the test.
      vi.stubEnv("OPENMAPX_INTEGRATION_CODE_CACHE_DIR", join(parent, "code-cache"));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(parent, { recursive: true, force: true });
      for (const key of Object.keys(g)) if (key.startsWith("__omxInstalled")) delete g[key];
    });

    function writeInstalled(
      id: string,
      bundle: string,
      options: { declared?: boolean; domains?: string[]; manifest?: Record<string, unknown> } = {},
    ) {
      const directory = join(installedRoot, id);
      mkdirSync(join(directory, "dist", "backend"), { recursive: true });
      writeFileSync(
        join(directory, "manifest.json"),
        JSON.stringify({
          id,
          version: "1.0.0",
          platform: "1.0",
          license: "MIT",
          domains: options.domains ?? ["knowledge"],
          quality: "community",
          ...(options.declared === false ? {} : { backend: { entry: "dist/backend/index.mjs" } }),
          ...options.manifest,
        }),
      );
      writeFileSync(join(directory, "dist", "backend", "index.mjs"), bundle);
      return directory;
    }

    function writeBuiltIn(id: string, source: string, manifest: Record<string, unknown> = {}) {
      const directory = join(builtInRoot, id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "manifest.json"),
        JSON.stringify({
          id,
          version: "1.0.0",
          license: "MIT",
          domains: ["knowledge"],
          quality: "built-in",
          ...manifest,
        }),
      );
      writeFileSync(join(directory, "index.js"), source);
    }

    const installed = () => ({ directory: installedRoot, isBuiltIn: false });
    const builtIn = () => ({ directory: builtInRoot, isBuiltIn: true });

    it("imports an installed backend bundle through the verified cache", async () => {
      writeInstalled(
        "demo",
        [
          "// imports an installed backend bundle through the verified cache",
          'import { registerPlaceResolver } from "@openmapx/integration-sdk/places";',
          "export function setup(ctx) {",
          "  globalThis.__omxInstalledLoaded = import.meta.url;",
          '  registerPlaceResolver("demo", async () => null);',
          '  ctx.registerRoute("GET", "/owned", (_request, reply) => reply.send({ owned: true }));',
          "}",
        ].join("\n"),
      );
      const app = makeApp();

      await initIntegrations(app, [installed()]);

      expect(getIntegration("demo")?.loadState).toBe("loaded");
      expect(getIntegration("demo")?.loadError).toBeUndefined();
      expect(g.__omxInstalledLoaded).toMatch(/[\\/]demo[\\/][a-f0-9]{64}[\\/]index\.mjs$/);
      expect(getPlaceResolver("demo")).toBeTypeOf("function");
      expect((await app.inject("/api/integrations/demo/owned")).statusCode).toBe(200);
    });

    it("serves no installed frontend bundle", async () => {
      const directory = writeInstalled(
        "demo",
        "// serves no installed frontend bundle\nexport function setup() {}\n",
      );
      mkdirSync(join(directory, "dist", "frontend"), { recursive: true });
      writeFileSync(join(directory, "dist", "frontend", "index.js"), "globalThis.owned = true;");
      const app = makeApp();

      await initIntegrations(app, [installed()]);

      expect((await app.inject("/api/integrations/demo/bundle/index.js")).statusCode).toBe(404);
    });

    it("gives two integrations with identical bundles separate module state", async () => {
      const bundle = [
        "// gives two integrations with identical bundles separate module state",
        "let n = 0;",
        "export function setup(ctx) {",
        '  ctx.registerRoute("GET", "/n", (_request, reply) => reply.send({ n: ++n }));',
        "}",
      ].join("\n");
      writeInstalled("a", bundle);
      writeInstalled("b", bundle);
      const app = makeApp();

      await initIntegrations(app, [installed()]);

      expect((await app.inject("/api/integrations/a/n")).json()).toEqual({ n: 1 });
      expect((await app.inject("/api/integrations/b/n")).json()).toEqual({ n: 1 });
    });

    it("does not import the same bytes again on reload", async () => {
      writeInstalled(
        "demo",
        [
          "// does not import the same bytes again on reload",
          "globalThis.__omxInstalledEvaluations = (globalThis.__omxInstalledEvaluations ?? 0) + 1;",
          "export function setup() {",
          "  globalThis.__omxInstalledSetups = (globalThis.__omxInstalledSetups ?? 0) + 1;",
          "}",
        ].join("\n"),
      );
      await initIntegrations(makeApp(), [installed()]);

      await reloadIntegrations();

      expect(g.__omxInstalledEvaluations).toBe(1);
      expect(g.__omxInstalledSetups).toBe(2);
      expect(getIntegration("demo")?.loadState).toBe("loaded");
    });

    it("imports new bytes after an update without a restart", async () => {
      const bundle = (version: string) =>
        [
          "// imports new bytes after an update without a restart",
          "export function setup(ctx) {",
          `  ctx.registerRoute("GET", "/version", (_request, reply) => reply.send({ version: ${JSON.stringify(version)} }));`,
          "}",
        ].join("\n");
      writeInstalled("demo", bundle("v1"));
      const app = makeApp();
      await initIntegrations(app, [installed()]);
      expect((await app.inject("/api/integrations/demo/version")).json()).toEqual({
        version: "v1",
      });

      writeInstalled("demo", bundle("v2"));
      await reloadIntegrations();

      expect((await app.inject("/api/integrations/demo/version")).json()).toEqual({
        version: "v2",
      });
    });

    it("leaves a failing installed integration out and keeps the rest of the generation", async () => {
      writeInstalled(
        "bad",
        [
          "// leaves a failing installed integration out and keeps the rest of the generation",
          'import { registerPlaceResolver } from "@openmapx/integration-sdk/places";',
          "export function setup(ctx) {",
          '  ctx.registerRoute("GET", "/owned", (_request, reply) => reply.send({ owned: true }));',
          '  registerPlaceResolver("bad", async () => null);',
          '  ctx.on("integration.loaded", (event) => globalThis.__omxInstalledSpy(event));',
          '  ctx.registerDisclosure({ kind: "ai-search", mode: "off" });',
          "  ctx.onActivate(() => { globalThis.__omxInstalledActivated = true; });",
          "  ctx.onShutdown(async () => {",
          "    globalThis.__omxInstalledShutdowns = (globalThis.__omxInstalledShutdowns ?? 0) + 1;",
          "  });",
          '  throw new Error("bad setup");',
          "}",
        ].join("\n"),
      );
      writeBuiltIn(
        "good",
        'export function setup(ctx) { ctx.registerRoute("GET", "/ok", (_q, reply) => reply.send({ ok: true })); }\n',
      );
      const spy = vi.fn();
      g.__omxInstalledSpy = spy;
      const app = makeApp();

      const expectLeftOut = async (shutdowns: number) => {
        expect(getIntegration("bad")).toMatchObject({
          enabled: false,
          loadState: "failed",
          loadError: { phase: "setup", message: "bad setup" },
        });
        expect(getIntegration("bad")?.disclosures).toBeUndefined();
        expect(getIntegration("good")?.loadState).toBe("loaded");
        expect((await app.inject("/api/integrations/good/ok")).statusCode).toBe(200);
        expect((await app.inject("/api/integrations/bad/owned")).statusCode).toBe(404);
        expect(getPlaceResolver("bad")).toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
        expect(g.__omxInstalledActivated).toBeUndefined();
        expect(g.__omxInstalledShutdowns).toBe(shutdowns);
        expect(failedIntegrationLoads(["bad", "good"])).toEqual([
          { id: "bad", phase: "setup", message: "bad setup" },
        ]);
        expect(failedIntegrationLoads(["good"])).toEqual([]);
      };

      await initIntegrations(app, [installed(), builtIn()]);
      await expectLeftOut(1);

      await reloadIntegrations();
      await expectLeftOut(2);
    });

    it("leaves out an installed integration whose migration fails, before importing it", async () => {
      const { applyExtensionMigrations } = getExtensionMigrationMocks();
      applyExtensionMigrations.mockImplementationOnce(async () => {
        throw new Error("Migration 0001_init.sql of demo changed after it was applied");
      });
      writeInstalled(
        "demo",
        [
          "// leaves out an installed integration whose migration fails, before importing it",
          "globalThis.__omxInstalledEvaluated = true;",
          "export function setup() { globalThis.__omxInstalledSetup = true; }",
        ].join("\n"),
        { manifest: { database: { migrations: true } } },
      );

      await initIntegrations(makeApp(), [installed()]);

      expect(applyExtensionMigrations).toHaveBeenCalledWith({
        integrationId: "demo",
        directory: join(installedRoot, "demo"),
      });
      expect(getIntegration("demo")).toMatchObject({
        enabled: false,
        loadState: "failed",
        loadError: {
          phase: "migrate",
          message: "Migration 0001_init.sql of demo changed after it was applied",
        },
      });
      expect(g.__omxInstalledEvaluated).toBeUndefined();
      expect(g.__omxInstalledSetup).toBeUndefined();
      expect(failedIntegrationLoads(["demo"])).toEqual([
        {
          id: "demo",
          phase: "migrate",
          message: "Migration 0001_init.sql of demo changed after it was applied",
        },
      ]);
    });

    it("migrates a built-in that declares migrations before importing it", async () => {
      const { applyExtensionMigrations } = getExtensionMigrationMocks();
      const evaluatedWhenMigrated: unknown[] = [];
      applyExtensionMigrations.mockImplementationOnce(async () => {
        evaluatedWhenMigrated.push(g.__omxInstalledBuiltInEvaluated);
        return { applied: ["0001_init.sql"], schemaAhead: false };
      });
      writeBuiltIn(
        "ledger",
        [
          "// migrates a built-in that declares migrations before importing it",
          "globalThis.__omxInstalledBuiltInEvaluated = true;",
          "export function setup() {}",
        ].join("\n"),
        { database: { migrations: true } },
      );

      await initIntegrations(makeApp(), [builtIn()]);

      expect(applyExtensionMigrations).toHaveBeenCalledWith({
        integrationId: "ledger",
        directory: join(builtInRoot, "ledger"),
      });
      expect(evaluatedWhenMigrated).toEqual([undefined]);
      expect(g.__omxInstalledBuiltInEvaluated).toBe(true);
      expect(getIntegration("ledger")?.loadState).toBe("loaded");
    });

    it("fails a built-in whose migration fails as phase migrate, without importing it", async () => {
      const { applyExtensionMigrations } = getExtensionMigrationMocks();
      const failure = "Migration 0001_init.sql of ledger failed at line 1: boom";
      applyExtensionMigrations.mockImplementationOnce(async () => {
        throw new Error(failure);
      });
      writeBuiltIn(
        "ledger",
        [
          "// fails a built-in whose migration fails as phase migrate, without importing it",
          "globalThis.__omxInstalledBuiltInEvaluated = true;",
          "export function setup() {}",
        ].join("\n"),
        { database: { migrations: true } },
      );

      await initIntegrations(makeApp(), [builtIn()]);

      expect(g.__omxInstalledBuiltInEvaluated).toBeUndefined();
      expect(getIntegration("ledger")).toMatchObject({
        enabled: false,
        loadState: "failed",
        loadError: { phase: "migrate", message: failure },
      });

      applyExtensionMigrations.mockImplementationOnce(async () => {
        throw new Error(failure);
      });
      await expect(reloadIntegrations()).rejects.toThrow(failure);
    });

    it("migrates only integrations that declare migrations", async () => {
      const { applyExtensionMigrations } = getExtensionMigrationMocks();
      writeInstalled("plain", "// migrates only integrations that declare migrations\n");

      await initIntegrations(makeApp(), [installed()]);

      expect(getIntegration("plain")?.loadState).toBe("loaded");
      expect(applyExtensionMigrations).not.toHaveBeenCalled();
    });

    it("loads an integration whose schema is ahead and raises an attention item", async () => {
      const { applyExtensionMigrations } = getExtensionMigrationMocks();
      const { raiseAttention, resolveAttention } = getAttentionMocks();
      applyExtensionMigrations.mockImplementationOnce(async () => ({
        applied: [],
        schemaAhead: true,
      }));
      writeInstalled(
        "demo",
        [
          "// loads an integration whose schema is ahead and raises an attention item",
          "export function setup() { globalThis.__omxInstalledSetup = true; }",
        ].join("\n"),
        { manifest: { name: "Demo Ledger", database: { migrations: true } } },
      );
      const app = makeApp();

      await initIntegrations(app, [installed()]);

      expect(getIntegration("demo")?.loadState).toBe("loaded");
      expect(g.__omxInstalledSetup).toBe(true);
      expect(raiseAttention).toHaveBeenCalledWith({
        key: "integration-schema-ahead:demo",
        severity: "warning",
        source: "extensions",
        title: "Demo Ledger runs against a newer database schema",
        detail:
          "A later version of this extension migrated its tables, and the files were rolled back. Install a fixed version.",
      });
      expect(resolveAttention).not.toHaveBeenCalled();

      await reloadIntegrations();

      expect(resolveAttention).toHaveBeenCalledWith("integration-schema-ahead:demo");
    });

    it("loads an integration when the attention list cannot be written", async () => {
      const { applyExtensionMigrations } = getExtensionMigrationMocks();
      const { resolveAttention } = getAttentionMocks();
      resolveAttention.mockImplementationOnce(async () => {
        throw new Error("database unavailable");
      });
      writeInstalled(
        "demo",
        "// loads an integration when the attention list cannot be written\n",
        { manifest: { database: { migrations: true } } },
      );

      await initIntegrations(makeApp(), [installed()]);

      expect(applyExtensionMigrations).toHaveBeenCalledOnce();
      expect(getIntegration("demo")?.loadState).toBe("loaded");
    });

    const lineSeparator = String.fromCodePoint(0x2028);
    it.each([
      ["a package outside the SDK", "@openmapx/integration-framework", ""],
      ["an SDK entry that does not exist", "@openmapx/integration-sdk/not-an-entry", ""],
      ["a host path alias", "@integrations/weather/index.ts", ""],
      // Node treats U+2028 as a line terminator, so these imports would run.
      ["a host path alias after U+2028", "@integrations/weather/index.ts", lineSeparator],
      [
        "host source after U+2028",
        new URL("../../../packages/place-ids/src/index.ts", import.meta.url).href,
        lineSeparator,
      ],
    ])(
      "records an unresolved import as an import failure (%s)",
      async (_label, specifier, before) => {
        writeInstalled(
          "deep",
          [
            `// records an unresolved import as an import failure: ${specifier}`,
            `${before}import ${JSON.stringify(specifier)};`,
            "globalThis.__omxInstalledDeepEvaluated = true;",
            "export function setup() {}",
          ].join("\n"),
        );

        await initIntegrations(makeApp(), [installed()]);

        expect(getIntegration("deep")).toMatchObject({
          enabled: false,
          loadState: "failed",
          loadError: { phase: "import", message: expect.stringContaining(specifier) },
        });
        expect(g.__omxInstalledDeepEvaluated).toBeUndefined();
      },
    );

    it("still discards the generation when a built-in fails on reload", async () => {
      writeInstalled(
        "demo",
        [
          "// still discards the generation when a built-in fails on reload",
          "export function setup(ctx) {",
          '  ctx.registerRoute("GET", "/owned", (_request, reply) => reply.send({ owned: true }));',
          "}",
        ].join("\n"),
      );
      writeBuiltIn(
        "fragile",
        'export function setup() { if (globalThis.__omxInstalledFragile) throw new Error("fragile setup"); }\n',
      );
      const app = makeApp();
      await initIntegrations(app, [installed(), builtIn()]);
      g.__omxInstalledFragile = true;

      await expect(reloadIntegrations()).rejects.toThrow("fragile setup");

      expect(getIntegration("fragile")?.loadState).toBe("loaded");
      expect(getIntegration("demo")?.loadState).toBe("loaded");
      expect((await app.inject("/api/integrations/demo/owned")).statusCode).toBe(200);
    });

    const HOSTILE_PROXY =
      "new Proxy(Object.freeze({}), { get() { throw new Error('trap'); }, has() { throw new Error('trap'); }, getPrototypeOf() { throw new Error('trap'); }, getOwnPropertyDescriptor() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } })";

    it("reports a built-in whose setup throws a proxy with an error that describes it", async () => {
      writeBuiltIn(
        "listener",
        [
          "// reports a built-in whose setup throws a proxy with an error that describes it",
          "export function setup(ctx) {",
          '  ctx.on("integration.error", (event) => {',
          "    globalThis.__omxInstalledErrors = [...(globalThis.__omxInstalledErrors ?? []),",
          "      [event.integrationId, event.error instanceof Error, event.error.message]];",
          "  });",
          "}",
        ].join("\n"),
      );
      writeBuiltIn("thrower", `export function setup() { throw ${HOSTILE_PROXY}; }\n`, {
        dependencies: ["listener"],
      });

      await initIntegrations(makeApp(), [builtIn()]);

      expect(getIntegration("thrower")).toMatchObject({
        loadState: "failed",
        loadError: { phase: "setup", message: "a value that cannot be shown" },
      });
      expect(g.__omxInstalledErrors).toEqual([["thrower", true, "a value that cannot be shown"]]);
    });

    it("answers the reload endpoint with a description when a reload throws a proxy", async () => {
      writeBuiltIn(
        "fragile",
        `export function setup() { if (globalThis.__omxInstalledFragile) throw ${HOSTILE_PROXY}; }\n`,
      );
      const app = makeApp();
      await initIntegrations(app, [builtIn()]);
      g.__omxInstalledFragile = true;

      const response = await app.inject({ method: "POST", url: "/api/integrations/reload" });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: "Reload failed",
        message: "a value that cannot be shown",
      });
    });

    it("ignores late context calls of a retired generation with one warning per method", async () => {
      writeInstalled(
        "late",
        [
          "// ignores late context calls of a retired generation with one warning per method",
          'import { registerPlaceResolver } from "@openmapx/integration-sdk/places";',
          "const weather = (id) => ({ id, priority: 1, getCurrentWeather: async () => null });",
          "let generation = 0;",
          "export function setup(ctx) {",
          "  generation += 1;",
          "  ctx.registerWeatherProvider(weather(`p${generation}`));",
          "  if (generation === 2) {",
          '    ctx.on("late.refreshed", () => { globalThis.__omxInstalledHeard = true; });',
          "    return;",
          "  }",
          "  setTimeout(async () => {",
          "    await globalThis.__omxInstalledGate;",
          '    ctx.registerWeatherProvider(weather("late-1"));',
          '    ctx.registerWeatherProvider(weather("late-2"));',
          '    ctx.registerRoute("GET", "/late", (_request, reply) => reply.send({ late: true }));',
          '    ctx.emit("late.refreshed", {});',
          '    const unsubscribe = ctx.on("late.refreshed", () => {});',
          "    unsubscribe();",
          "    const accepted = ctx.setDataSources([]);",
          '    registerPlaceResolver("late", async () => null);',
          "    ctx.onShutdown(async () => {});",
          '    ctx.schedule("late-task", { everyMs: 60000, deadlineMs: 5000 }, async () => {});',
          '    ctx.schedule("late-task", { everyMs: 60000, deadlineMs: 5000 }, async () => {});',
          "    const handler = { erase: async () => {}, export: async () => null };",
          "    ctx.registerSubjectDataHandler(handler);",
          "    ctx.registerSubjectDataHandler(handler);",
          "    globalThis.__omxInstalledLateDone = { accepted };",
          "  }, 0);",
          "}",
        ].join("\n"),
        { domains: ["weather"] },
      );
      let open: () => void = () => {};
      g.__omxInstalledGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on("unhandledRejection", onRejection);
      const warn = vi.fn();
      const app = makeApp();
      // biome-ignore lint/suspicious/noExplicitAny: test-only log patch
      (app as any).log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
      try {
        await initIntegrations(app, [installed()]);
        await reloadIntegrations();

        open();
        await vi.waitFor(() => expect(g.__omxInstalledLateDone).toBeDefined());
        await new Promise((resolve) => setImmediate(resolve));

        expect(rejections).toEqual([]);
        expect(g.__omxInstalledLateDone).toEqual({ accepted: [] });
        expect(getIntegration("late")?.loadState).toBe("loaded");
        expect(
          getIntegrationProviders("late", "weather").map(
            (provider) => (provider as { id: string }).id,
          ),
        ).toEqual(["p2"]);
        expect((await app.inject("/api/integrations/late/late")).statusCode).toBe(404);
        expect(g.__omxInstalledHeard).toBeUndefined();
        expect(getPlaceResolver("late")).toBeUndefined();
        const ignored = warn.mock.calls
          .map(([, message]) => String(message))
          .filter((message) => message.includes("was unloaded"));
        expect(ignored.sort()).toEqual(
          [
            "emit",
            "on",
            "onShutdown",
            "registerPlaceResolver",
            "registerRoute",
            "registerSubjectDataHandler",
            "registerWeatherProvider",
            "schedule",
            "setDataSources",
          ].map((method) => `Integration late was unloaded; ignoring ${method}`),
        );
      } finally {
        process.off("unhandledRejection", onRejection);
      }
    });

    describe("subject-data handlers", () => {
      /** The real handler-table and erasure logic over the live registry, in memory. */
      function subjectDataOverRegistry(pending: Array<[string, string]> = []) {
        const synced: Array<{ handling: readonly string[]; stopped: readonly string[] }> = [];
        const rows = [...pending];
        const subjectData = createExtensionSubjectData({
          store: {
            syncHandlers: async ({ handling, stopped }) => {
              synced.push({ handling, stopped });
              return new Map();
            },
            pendingSubjects: async (id) =>
              rows.filter(([integrationId]) => integrationId === id).map(([, subject]) => subject),
            eraseLocked: async (id, subject, erase) => {
              const attempt = await erase();
              if (attempt.ok)
                rows.splice(
                  rows.findIndex(([i, s]) => i === id && s === subject),
                  1,
                );
              return attempt;
            },
            recordStalled: async () => {},
            pendingSummary: async () => {
              const summary = new Map<string, { count: number; attempts: number }>();
              for (const [id] of rows)
                summary.set(id, { count: (summary.get(id)?.count ?? 0) + 1, attempts: 0 });
              return summary;
            },
            count: async (ids) => rows.filter(([id]) => ids.includes(id)).length,
            migrated: async () => new Set(),
          },
          integrations: getAllIntegrations,
          attention: {
            raise: vi.fn(async () => {}),
            resolve: vi.fn(async () => {}),
            openKeys: vi.fn(async () => []),
          },
          log: { warn: vi.fn() },
        });
        return { ...subjectData, synced, rows };
      }

      it("lists the handler after activation and erases through it in the integration's scope", async () => {
        const { syncSubjectHandlerTable, runPendingErasures } = getSubjectDataMocks();
        writeInstalled(
          "notes",
          [
            "// lists the handler after activation and erases through it in the integration's scope",
            "export function setup(ctx) {",
            "  ctx.registerSubjectDataHandler({",
            "    async erase(subjectId) { (globalThis.__omxInstalledErased ??= []).push(subjectId); },",
            "    async export() { return null; },",
            "  });",
            "}",
          ].join("\n"),
        );
        writeInstalled("plain", "// lists the handler after activation: no handler\n");

        await initIntegrations(makeApp(), [installed()]);

        expect(getIntegration("notes")?.loadState).toBe("loaded");
        expect(syncSubjectHandlerTable).toHaveBeenCalledOnce();
        expect(runPendingErasures).toHaveBeenCalledOnce();
        expect(syncSubjectHandlerTable.mock.invocationCallOrder[0]).toBeLessThan(
          runPendingErasures.mock.invocationCallOrder[0] ?? 0,
        );
        const real = subjectDataOverRegistry([["notes", "u1"]]);
        await real.syncSubjectHandlerTable();
        expect(real.synced).toEqual([{ handling: ["notes"], stopped: ["plain"] }]);
        expect(await real.runPendingErasures()).toEqual({ erased: 1, failed: 0 });
        expect(g.__omxInstalledErased).toEqual(["u1"]);

        await reloadIntegrations();
        expect(syncSubjectHandlerTable).toHaveBeenCalledTimes(2);
        expect(runPendingErasures).toHaveBeenCalledTimes(2);
      });

      it("fails the load of an integration that registers a second handler", async () => {
        writeInstalled(
          "twice",
          [
            "// fails the load of an integration that registers a second handler",
            "export function setup(ctx) {",
            "  const handler = { erase: async () => {}, export: async () => null };",
            "  ctx.registerSubjectDataHandler(handler);",
            "  ctx.registerSubjectDataHandler(handler);",
            "}",
          ].join("\n"),
        );

        await initIntegrations(makeApp(), [installed()]);

        expect(getIntegration("twice")).toMatchObject({
          loadState: "failed",
          loadError: {
            phase: "setup",
            message: "Integration twice already registered a subject-data handler",
          },
        });
      });

      it("ignores a handler registered after setup with one warning", async () => {
        writeInstalled(
          "slow",
          [
            "// ignores a handler registered after setup with one warning",
            "export function setup(ctx) { globalThis.__omxInstalledCtx = ctx; }",
          ].join("\n"),
        );
        const warn = vi.fn();
        const app = makeApp();
        // biome-ignore lint/suspicious/noExplicitAny: test-only log patch
        (app as any).log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
        await initIntegrations(app, [installed()]);
        const ctx = g.__omxInstalledCtx as IntegrationContext;
        const handler = { erase: async () => {}, export: async () => null };

        ctx.registerSubjectDataHandler(handler);
        ctx.registerSubjectDataHandler(handler);

        const real = subjectDataOverRegistry();
        await real.syncSubjectHandlerTable();
        expect(real.synced).toEqual([{ handling: [], stopped: ["slow"] }]);
        expect(
          warn.mock.calls
            .map(([, message]) => String(message))
            .filter((message) => message.includes("subject-data handler")),
        ).toEqual(["Integration slow registered a subject-data handler after setup; ignoring it"]);
      });

      it("loads the generation when the handler table cannot be written", async () => {
        const { syncSubjectHandlerTable, runPendingErasures } = getSubjectDataMocks();
        syncSubjectHandlerTable.mockRejectedValueOnce(new Error("database unavailable"));
        writeInstalled(
          "plain",
          "// loads the generation when the handler table cannot be written\n",
        );

        await initIntegrations(makeApp(), [installed()]);

        expect(getIntegration("plain")?.loadState).toBe("loaded");
        expect(runPendingErasures).toHaveBeenCalledOnce();
      });
    });

    describe("scheduled tasks", () => {
      const taskRuns = getTaskRunMocks();

      beforeEach(() => {
        taskRuns.rows.length = 0;
        // Only intervals are faked: the load deadline keeps real time.
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      const ticker = (comment: string, body: string[]) =>
        [`// ${comment}`, "export function setup(ctx) {", ...body, "}"].join("\n");

      it("starts a task once its generation is live", async () => {
        writeInstalled(
          "ticker",
          ticker("starts a task once its generation is live", [
            '  ctx.schedule("refresh", { everyMs: 60000, deadlineMs: 5000 }, async ({ signal }) => {',
            "    (globalThis.__omxInstalledRuns ??= []).push(signal.aborted);",
            "  });",
          ]),
        );

        await initIntegrations(makeApp(), [installed()]);
        expect(g.__omxInstalledRuns).toBeUndefined();
        vi.advanceTimersByTime(60_000);

        await vi.waitFor(() => expect(taskRuns.rows[0]?.status).toBe("succeeded"), {
          timeout: 10_000,
        });
        expect(g.__omxInstalledRuns).toEqual([false]);
        expect(taskRuns.rows).toEqual([
          expect.objectContaining({ integrationId: "ticker", taskName: "refresh" }),
        ]);
      });

      it("fails the load in setup when a task's options are invalid", async () => {
        writeInstalled(
          "ticker",
          ticker("fails the load in setup when a task's options are invalid", [
            '  ctx.schedule("refresh", { everyMs: 1000, deadlineMs: 5000 }, async () => {});',
          ]),
        );

        await initIntegrations(makeApp(), [installed()]);

        expect(getIntegration("ticker")).toMatchObject({
          loadState: "failed",
          loadError: { phase: "setup", message: expect.stringMatching(/everyMs/) },
        });
      });

      it("drops the tasks of an integration whose setup fails after scheduling them", async () => {
        writeInstalled(
          "ticker",
          ticker("drops the tasks of an integration whose setup fails", [
            '  ctx.schedule("refresh", { everyMs: 60000, deadlineMs: 5000 }, async () => {',
            "    globalThis.__omxInstalledRan = true;",
            "  });",
            '  throw new Error("setup failed");',
          ]),
        );

        await initIntegrations(makeApp(), [installed()]);
        vi.advanceTimersByTime(180_000);
        await new Promise((resolve) => setImmediate(resolve));

        expect(getIntegration("ticker")?.loadState).toBe("failed");
        expect(taskRuns.store.start).not.toHaveBeenCalled();
        expect(g.__omxInstalledRan).toBeUndefined();
      });

      it("ignores a task scheduled after setup with one warning", async () => {
        writeInstalled(
          "ticker",
          ticker("ignores a task scheduled after setup", [
            "  setTimeout(() => {",
            "    for (const name of ['late', 'late']) {",
            "      ctx.schedule(name, { everyMs: 60000, deadlineMs: 5000 }, async () => {",
            "        globalThis.__omxInstalledRan = true;",
            "      });",
            "    }",
            "    globalThis.__omxInstalledScheduled = true;",
            "  }, 0);",
          ]),
        );
        const warn = vi.fn();
        const app = makeApp();
        // biome-ignore lint/suspicious/noExplicitAny: test-only log patch
        (app as any).log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };

        await initIntegrations(app, [installed()]);
        await vi.waitFor(() => expect(g.__omxInstalledScheduled).toBe(true), { timeout: 10_000 });
        vi.advanceTimersByTime(180_000);
        await new Promise((resolve) => setImmediate(resolve));

        expect(getIntegration("ticker")?.loadState).toBe("loaded");
        expect(g.__omxInstalledRan).toBeUndefined();
        const ignored = warn.mock.calls
          .map(([, message]) => String(message))
          .filter((message) => message.includes("after setup"));
        expect(ignored).toEqual([
          "Integration ticker scheduled task late after setup; ignoring it",
        ]);
      });

      it("aborts a running task when a reload replaces its integration", async () => {
        writeInstalled(
          "ticker",
          ticker("aborts a running task when a reload replaces its integration", [
            "  const generation = (globalThis.__omxInstalledGeneration ?? 0) + 1;",
            "  globalThis.__omxInstalledGeneration = generation;",
            '  ctx.schedule("refresh", { everyMs: 60000, deadlineMs: 600000 }, ({ signal }) => {',
            "    (globalThis.__omxInstalledStarted ??= []).push(generation);",
            "    return new Promise((resolve) => {",
            "      if (generation > 1) return resolve();",
            '      signal.addEventListener("abort", () => {',
            "        globalThis.__omxInstalledAborted = generation;",
            "        resolve();",
            "      });",
            "    });",
            "  });",
          ]),
        );

        await initIntegrations(makeApp(), [installed()]);
        vi.advanceTimersByTime(60_000);
        await vi.waitFor(() => expect(g.__omxInstalledStarted).toEqual([1]), { timeout: 10_000 });

        await reloadIntegrations();
        await vi.waitFor(() => expect(g.__omxInstalledAborted).toBe(1), { timeout: 10_000 });
        vi.advanceTimersByTime(60_000);
        await vi.waitFor(() => expect(g.__omxInstalledStarted).toEqual([1, 2]), {
          timeout: 10_000,
        });
      });

      const countingTicker = (comment: string) =>
        ticker(comment, [
          '  ctx.schedule("refresh", { everyMs: 60000, deadlineMs: 5000 }, async () => {',
          "    globalThis.__omxInstalledRuns = (globalThis.__omxInstalledRuns ?? 0) + 1;",
          "  });",
        ]);

      it("stops the ticks of an integration that a reload no longer loads", async () => {
        writeInstalled(
          "ticker",
          countingTicker("stops the ticks of an integration that a reload no longer loads"),
        );
        await initIntegrations(makeApp(), [installed()]);
        vi.advanceTimersByTime(60_000);
        await vi.waitFor(() => expect(taskRuns.rows[0]?.status).toBe("succeeded"), {
          timeout: 10_000,
        });

        rmSync(join(installedRoot, "ticker"), { recursive: true, force: true });
        await reloadIntegrations();
        vi.advanceTimersByTime(180_000);
        await new Promise((resolve) => setImmediate(resolve));

        expect(getIntegration("ticker")).toBeUndefined();
        expect(g.__omxInstalledRuns).toBe(1);
        expect(taskRuns.rows).toHaveLength(1);
      });

      it("loads an integration and its task again after a reload that failed", async () => {
        writeInstalled(
          "ticker",
          countingTicker("loads an integration and its task again after a reload that failed"),
        );
        writeBuiltIn(
          "fragile",
          'export function setup() { if (globalThis.__omxInstalledFragile) throw new Error("fragile setup"); }\n',
        );
        await initIntegrations(makeApp(), [installed(), builtIn()]);
        g.__omxInstalledFragile = true;
        await expect(reloadIntegrations()).rejects.toThrow("fragile setup");
        g.__omxInstalledFragile = false;

        await reloadIntegrations();
        vi.advanceTimersByTime(60_000);

        expect(getIntegration("ticker")).toMatchObject({ loadState: "loaded" });
        await vi.waitFor(() => expect(g.__omxInstalledRuns).toBe(1), { timeout: 10_000 });
      });
    });

    describe("integration scope and setup deadline", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("leaves out an installed integration whose setup does not settle in 60 seconds", async () => {
        // Fake timers do not carry the async context into their callbacks the
        // way Node's timers do, so the late work binds it explicitly.
        writeInstalled(
          "hang",
          [
            "// leaves out an installed integration whose setup does not settle in 60 seconds",
            'import { AsyncResource } from "node:async_hooks";',
            'import { registerPlaceResolver } from "@openmapx/integration-sdk/places";',
            "const weather = (id) => ({ id, priority: 1, getCurrentWeather: async () => null });",
            "export async function setup(ctx) {",
            '  ctx.registerWeatherProvider(weather("p1"));',
            "  setTimeout(AsyncResource.bind(() => {",
            '    registerPlaceResolver("late", async () => null);',
            '    ctx.registerWeatherProvider(weather("p2"));',
            "    globalThis.__omxInstalledLate = true;",
            "  }), 61_000);",
            "  globalThis.__omxInstalledEntered = true;",
            "  await new Promise(() => {});",
            "}",
          ].join("\n"),
          { domains: ["weather"] },
        );
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        const warn = vi.fn();
        const app = makeApp();
        // biome-ignore lint/suspicious/noExplicitAny: test-only log patch
        (app as any).log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };

        const boot = initIntegrations(app, [installed()]);
        await vi.waitFor(() => expect(g.__omxInstalledEntered).toBe(true), { timeout: 5_000 });
        await vi.advanceTimersByTimeAsync(61_000);
        await boot;

        expect(getIntegration("hang")).toMatchObject({
          enabled: false,
          loadState: "failed",
          loadError: { phase: "deadline" },
        });
        expect(getIntegrationsByDomain("weather")).toHaveLength(0);
        expect(getIntegrationProviders("hang", "weather")).toHaveLength(0);
        expect(g.__omxInstalledLate).toBe(true);
        expect(getPlaceResolver("late")).toBeUndefined();
        expect(
          warn.mock.calls
            .map(([, message]) => String(message))
            .filter((message) => message.includes("was unloaded"))
            .sort(),
        ).toEqual([
          "Integration hang was unloaded; ignoring registerPlaceResolver",
          "Integration hang was unloaded; ignoring registerWeatherProvider",
        ]);
      });

      /**
       * Advances the fake clock a second at a time, yielding to the real event
       * loop in between, until `work` settles. The deadline is armed only after
       * the work's real asynchronous steps before the import, which take an
       * unknown share of real time on a loaded machine, so the wait is bounded
       * by real time rather than by fake seconds: a fixed number of fake seconds
       * passes in a few milliseconds and can run out before the timer exists.
       */
      async function advanceUntilSettled(work: Promise<unknown>, realTimeoutMs = 10_000) {
        let settled = false;
        void work.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const startedAt = performance.now();
        while (!settled && performance.now() - startedAt < realTimeoutMs) {
          await new Promise((resolve) => setImmediate(resolve));
          await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(settled).toBe(true);
        await work;
      }

      it("leaves out an installed integration whose import never settles and loads the rest", async () => {
        writeInstalled(
          "stuck",
          [
            "// leaves out an installed integration whose import never settles and loads the rest",
            "globalThis.__omxInstalledEntered = true;",
            "await new Promise(() => {});",
            "export function setup() { globalThis.__omxInstalledSetupRan = true; }",
          ].join("\n"),
        );
        writeBuiltIn(
          "good",
          'export function setup(ctx) { ctx.registerRoute("GET", "/ok", (_q, reply) => reply.send({ ok: true })); }\n',
        );
        const app = makeApp();
        vi.useFakeTimers({ toFake: ["setTimeout"] });

        const expectLeftOut = async () => {
          expect(getIntegration("stuck")).toMatchObject({
            enabled: false,
            loadState: "failed",
            loadError: {
              phase: "deadline",
              message: "Import and setup did not finish within 60 seconds",
            },
          });
          expect(failedIntegrationLoads(["stuck", "good"])).toEqual([
            {
              id: "stuck",
              phase: "deadline",
              message: "Import and setup did not finish within 60 seconds",
            },
          ]);
          expect(getIntegration("good")?.loadState).toBe("loaded");
          expect((await app.inject("/api/integrations/good/ok")).statusCode).toBe(200);
          expect(g.__omxInstalledSetupRan).toBeUndefined();
        };

        const boot = initIntegrations(app, [installed(), builtIn()]);
        await vi.waitFor(() => expect(g.__omxInstalledEntered).toBe(true), { timeout: 5_000 });
        await vi.advanceTimersByTimeAsync(60_000);
        await boot;
        await expectLeftOut();

        // Node keeps the pending evaluation for the same bytes, so the reload's
        // import does not settle either.
        await advanceUntilSettled(reloadIntegrations());
        await expectLeftOut();
      });

      it("gives a setup only what is left of the budget after a slow import", async () => {
        writeInstalled(
          "slow-import",
          [
            "// gives a setup only what is left of the budget after a slow import",
            "globalThis.__omxInstalledEntered = true;",
            "await new Promise((resolve) => setTimeout(resolve, 50_000));",
            "export async function setup(ctx) {",
            "  globalThis.__omxInstalledSetupStarted = true;",
            "  await new Promise((resolve) => setTimeout(resolve, 20_000));",
            '  ctx.registerRoute("GET", "/ok", (_q, reply) => reply.send({ ok: true }));',
            "}",
          ].join("\n"),
        );
        const app = makeApp();
        vi.useFakeTimers({ toFake: ["setTimeout"] });

        let settled = false;
        const boot = initIntegrations(app, [installed()]).finally(() => {
          settled = true;
        });
        await vi.waitFor(() => expect(g.__omxInstalledEntered).toBe(true), { timeout: 5_000 });
        await vi.advanceTimersByTimeAsync(50_000);
        await vi.waitFor(() => expect(g.__omxInstalledSetupStarted).toBe(true), {
          timeout: 5_000,
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
        await boot;

        expect(getIntegration("slow-import")).toMatchObject({
          enabled: false,
          loadState: "failed",
          loadError: { phase: "deadline" },
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect((await app.inject("/api/integrations/slow-import/ok")).statusCode).toBe(404);
      });

      it("does not run setup when the import settles after the deadline", async () => {
        writeInstalled(
          "late-import",
          [
            "// does not run setup when the import settles after the deadline",
            "globalThis.__omxInstalledEntered = true;",
            "await new Promise((resolve) => setTimeout(resolve, 70_000));",
            "export function setup(ctx) {",
            "  globalThis.__omxInstalledSetupRan = true;",
            '  ctx.registerRoute("GET", "/ok", (_q, reply) => reply.send({ ok: true }));',
            "}",
          ].join("\n"),
        );
        const app = makeApp();
        vi.useFakeTimers({ toFake: ["setTimeout"] });

        const boot = initIntegrations(app, [installed()]);
        await vi.waitFor(() => expect(g.__omxInstalledEntered).toBe(true), { timeout: 5_000 });
        await vi.advanceTimersByTimeAsync(60_000);
        await boot;
        await vi.advanceTimersByTimeAsync(10_000);
        await new Promise((resolve) => setImmediate(resolve));

        expect(getIntegration("late-import")).toMatchObject({
          enabled: false,
          loadState: "failed",
          loadError: { phase: "deadline" },
        });
        expect(g.__omxInstalledSetupRan).toBeUndefined();
        expect((await app.inject("/api/integrations/late-import/ok")).statusCode).toBe(404);
      });

      it("revokes a retired installed generation before the reload awaits anything", async () => {
        // The first generation keeps work bound to its own scope. The attribution
        // refresh, the first thing the reload awaits after its commit, runs it,
        // so it lands in the gap between the commit and that await.
        writeInstalled(
          "retired",
          [
            "// revokes a retired installed generation before the reload awaits anything",
            'import { AsyncResource } from "node:async_hooks";',
            'import { registerPlaceResolver } from "@openmapx/integration-sdk/places";',
            "export function setup(ctx) {",
            "  const generation = (globalThis.__omxInstalledGenerations ?? 0) + 1;",
            "  globalThis.__omxInstalledGenerations = generation;",
            "  if (generation !== 1) return;",
            "  globalThis.__omxInstalledLateWork = AsyncResource.bind(() => {",
            "    globalThis.__omxInstalledLateRan = true;",
            '    registerPlaceResolver("retired", async () => ({ generation }));',
            "  });",
            '  ctx.on("integration.unloaded", () => {',
            '    registerPlaceResolver("retired", async () => ({ generation }));',
            "  });",
            "}",
          ].join("\n"),
        );
        await initIntegrations(makeApp(), [installed()]);
        let resolverAfterLateWork: unknown = "not run";
        vi.mocked(getAttributionIndex).mockReturnValue({
          setIntegrationManifests: () => undefined,
          reload: async () => {
            (g.__omxInstalledLateWork as (() => void) | undefined)?.();
            resolverAfterLateWork = getPlaceResolver("retired");
          },
          close: () => undefined,
        } as unknown as ReturnType<typeof getAttributionIndex>);

        try {
          await reloadIntegrations();
        } finally {
          vi.mocked(getAttributionIndex).mockReturnValue(null);
        }

        expect(g.__omxInstalledGenerations).toBe(2);
        expect(g.__omxInstalledLateRan).toBe(true);
        expect(resolverAfterLateWork).toBeUndefined();
        expect(getPlaceResolver("retired")).toBeUndefined();
      });

      it("only warns for a built-in that is slow to set up", async () => {
        writeBuiltIn(
          "slow",
          [
            "export async function setup(ctx) {",
            "  globalThis.__omxInstalledSlowEntered = true;",
            "  await new Promise((resolve) => setTimeout(resolve, 61_000));",
            '  ctx.registerRoute("GET", "/ok", (_q, reply) => reply.send({ ok: true }));',
            "}",
          ].join("\n"),
        );
        const app = makeApp();
        const warn = vi.spyOn(app.log, "warn");
        vi.useFakeTimers({ toFake: ["setTimeout"] });

        const boot = initIntegrations(app, [builtIn()]);
        await vi.waitFor(() => expect(g.__omxInstalledSlowEntered).toBe(true), {
          timeout: 5_000,
        });
        await vi.advanceTimersByTimeAsync(61_000);
        await boot;

        expect(getIntegration("slow")).toMatchObject({ enabled: true, loadState: "loaded" });
        expect((await app.inject("/api/integrations/slow/ok")).statusCode).toBe(200);
        const slowWarnings = warn.mock.calls.filter((call) =>
          call.some((part) => typeof part === "string" && /slow.*10 seconds/.test(part)),
        );
        expect(slowWarnings).toHaveLength(1);
      });

      it("runs route handlers inside the integration's scope", async () => {
        g.__omxInstalledScope = currentIntegrationScope;
        writeInstalled(
          "demo",
          [
            "// runs route handlers inside the integration's scope",
            "export function setup(ctx) {",
            '  ctx.registerRoute("GET", "/scope", async (_request, reply) => {',
            "    await new Promise((resolve) => setImmediate(resolve));",
            "    reply.send({ scope: globalThis.__omxInstalledScope()?.integrationId ?? null });",
            "  });",
            "}",
          ].join("\n"),
        );
        const app = makeApp();
        await initIntegrations(app, [installed()]);

        expect((await app.inject("/api/integrations/demo/scope")).json()).toEqual({
          scope: "demo",
        });
      });

      it("returns the bound provider from the registry", async () => {
        g.__omxInstalledScope = currentIntegrationScope;
        writeInstalled(
          "demo",
          [
            "// returns the bound provider from the registry",
            "export function setup(ctx) {",
            "  const provider = {",
            '    id: "w",',
            "    priority: 1,",
            "    async getCurrentWeather() { return globalThis.__omxInstalledScope()?.integrationId; },",
            "  };",
            "  globalThis.__omxInstalledProvider = provider;",
            "  ctx.registerWeatherProvider(provider);",
            "}",
          ].join("\n"),
          { domains: ["weather"] },
        );
        await initIntegrations(makeApp(), [installed()]);

        const [registered] = getIntegrationProviders<{
          id: string;
          getCurrentWeather(): Promise<string | undefined>;
        }>("demo", "weather");
        expect(registered).toBeDefined();
        expect(registered).not.toBe(g.__omxInstalledProvider);
        expect(registered?.id).toBe("w");
        expect(await registered?.getCurrentWeather()).toBe("demo");
      });

      it("runs an installed place resolver in the integration's scope, up to a deadline", async () => {
        g.__omxInstalledScope = currentIntegrationScope;
        writeInstalled(
          "demo",
          [
            "// runs an installed place resolver in the integration's scope, up to a deadline",
            'import { registerPlaceResolver } from "@openmapx/integration-sdk/places";',
            "export function setup() {",
            '  registerPlaceResolver("demo", async (value) => {',
            '    if (value === "hang") return new Promise(() => {});',
            "    return { scope: globalThis.__omxInstalledScope()?.integrationId ?? null };",
            "  });",
            "}",
          ].join("\n"),
        );
        await initIntegrations(makeApp(), [installed()]);
        const resolver = getPlaceResolver("demo");

        expect(await resolver?.("1", {})).toEqual({ scope: "demo" });
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        const hung = resolver?.("hang", {});
        let settled = false;
        hung?.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const outcome = expect(hung).rejects.toThrow("provider deadline exceeded");
        await vi.advanceTimersByTimeAsync(29_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        await outcome;
      });

      it("lets a reload and shutdown finish while an unloaded integration's shutdown handler queries ctx.db", async () => {
        writeInstalled(
          "ledger",
          [
            "// lets a reload and shutdown finish while an unloaded integration's shutdown handler queries ctx.db",
            "export function setup(ctx) {",
            "  ctx.onShutdown(async () => {",
            '    const rows = await ctx.db.execute("delete from pending returning id");',
            "    globalThis.__omxInstalledFlushes = [...(globalThis.__omxInstalledFlushes ?? []), rows];",
            "  });",
            "}",
          ].join("\n"),
          { manifest: { database: { migrations: true } } },
        );
        const warn = vi.fn();
        const app = makeApp();
        // biome-ignore lint/suspicious/noExplicitAny: test-only log patch
        (app as any).log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
        await initIntegrations(app, [installed()]);

        await reloadIntegrations();
        await shutdownIntegrations();

        expect(g.__omxInstalledFlushes).toEqual([[], []]);
        expect(
          warn.mock.calls
            .map(([, message]) => String(message))
            .filter((message) => message.includes("was unloaded")),
        ).toEqual([
          "Integration ledger was unloaded; still running db.execute",
          "Integration ledger was unloaded; still running db.execute",
        ]);
      });

      /**
       * Runs `work` until a shutdown handler that never settles has been
       * entered `hangs` times in all, moves the fake clock past the shutdown
       * handler deadline, and expects `work` to settle.
       */
      async function settlesPastHungShutdownHandler(work: Promise<unknown>, hangs: number) {
        let settled = false;
        void work.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await vi.waitFor(() => expect(g.__omxInstalledHangs).toBe(hangs), { timeout: 5_000 });
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
        await work;
      }

      it("does not let a shutdown handler that never settles hold up a reload", async () => {
        writeInstalled(
          "stuck-shutdown",
          [
            "// does not let a shutdown handler that never settles hold up a reload",
            "export function setup(ctx) {",
            "  globalThis.__omxInstalledSetups = (globalThis.__omxInstalledSetups ?? 0) + 1;",
            "  ctx.onShutdown(() => {",
            "    globalThis.__omxInstalledHangs = (globalThis.__omxInstalledHangs ?? 0) + 1;",
            "    return new Promise(() => {});",
            "  });",
            "  ctx.onShutdown(async () => {",
            "    globalThis.__omxInstalledLaterHandlers = (globalThis.__omxInstalledLaterHandlers ?? 0) + 1;",
            "  });",
            "}",
          ].join("\n"),
        );
        const warn = vi.fn();
        const app = makeApp();
        // biome-ignore lint/suspicious/noExplicitAny: test-only log patch
        (app as any).log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
        await initIntegrations(app, [installed()]);
        // Each generation's setup deadline is cleared before the previous
        // generation's handlers run, so moving the clock reaches only the
        // deadlines of handlers that have not finished.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        await settlesPastHungShutdownHandler(reloadIntegrations(), 1);
        await settlesPastHungShutdownHandler(reloadIntegrations(), 2);
        await settlesPastHungShutdownHandler(shutdownIntegrations(), 3);

        expect(g.__omxInstalledSetups).toBe(3);
        expect(g.__omxInstalledLaterHandlers).toBe(2);
        expect(
          warn.mock.calls
            .map(([, message]) => String(message))
            .filter((message) => message.startsWith("A shutdown handler")),
        ).toEqual(
          Array.from(
            { length: 2 },
            () =>
              "A shutdown handler of integration stuck-shutdown did not finish within 10 seconds; going on without it",
          ),
        );
      });

      it("gives the shutdown handlers of installed integrations one budget in all at process shutdown", async () => {
        const hangingOnShutdown = (id: string) => [
          `// gives the shutdown handlers of installed integrations one budget in all: ${id}`,
          "export function setup(ctx) {",
          "  ctx.onShutdown(() => {",
          "    globalThis.__omxInstalledHangs = (globalThis.__omxInstalledHangs ?? 0) + 1;",
          "    return new Promise(() => {});",
          "  });",
          "}",
        ];
        writeInstalled("stuck-a", hangingOnShutdown("stuck-a").join("\n"));
        writeInstalled("stuck-b", hangingOnShutdown("stuck-b").join("\n"));
        writeInstalled(
          "tidy",
          [
            "// gives the shutdown handlers of installed integrations one budget in all: tidy",
            "export function setup(ctx) {",
            "  ctx.onShutdown(() => { throw new Error('first handler failed'); });",
            "  ctx.onShutdown(async () => { globalThis.__omxInstalledTidied = true; });",
            "}",
          ].join("\n"),
        );
        const warn = vi.fn();
        const app = makeApp();
        // biome-ignore lint/suspicious/noExplicitAny: test-only log patch
        (app as any).log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
        await initIntegrations(app, [installed()]);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        let settled = false;
        const shutdown = shutdownIntegrations().then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(g.__omxInstalledHangs).toBe(2);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await shutdown;

        expect(g.__omxInstalledTidied).toBe(true);
        expect(
          warn.mock.calls.filter(([, message]) => String(message).includes("did not finish")),
        ).toEqual([
          [
            { integrationIds: ["stuck-a", "stuck-b"] },
            "Shutdown handlers of integrations stuck-a, stuck-b did not finish within 5 seconds in all; shutting down without them",
          ],
        ]);
      });

      it("does not let a shutdown handler that never settles hold up start-up when its integration is left out", async () => {
        writeInstalled(
          "stuck-left-out",
          [
            "// does not let a shutdown handler that never settles hold up start-up when its integration is left out",
            "export function setup(ctx) {",
            "  ctx.onShutdown(() => {",
            "    globalThis.__omxInstalledHangs = (globalThis.__omxInstalledHangs ?? 0) + 1;",
            "    return new Promise(() => {});",
            "  });",
            '  throw new Error("setup failed");',
            "}",
          ].join("\n"),
        );
        // The setup deadline is cleared before the handlers of the left-out
        // integration run, so moving the clock reaches only theirs.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        await settlesPastHungShutdownHandler(initIntegrations(makeApp(), [installed()]), 1);

        expect(getIntegration("stuck-left-out")).toMatchObject({
          loadState: "failed",
          loadError: { phase: "setup", message: "setup failed" },
        });
      });
    });

    it.each([
      ["an object without a prototype", "Object.create(null)", "a value that cannot be shown"],
      [
        "a proxy that throws on every access",
        "new Proxy({}, { get() { throw new Error('trap'); }, getPrototypeOf() { throw new Error('trap'); } })",
        "a value that cannot be shown",
      ],
      ["a symbol", "Symbol('odd')", "Symbol(odd)"],
    ])(
      "leaves out an integration whose setup throws %s, with a description of it",
      async (label, value, message) => {
        writeInstalled(
          "odd-throw",
          [
            `// leaves out an integration whose setup throws ${label}`,
            `export function setup() { throw ${value}; }`,
          ].join("\n"),
        );

        await initIntegrations(makeApp(), [installed()]);

        expect(getIntegration("odd-throw")).toMatchObject({
          loadState: "failed",
          loadError: { phase: "setup", message },
        });
      },
    );

    it("ignores a bundle the manifest does not declare", async () => {
      writeInstalled(
        "demo",
        [
          "// ignores a bundle the manifest does not declare",
          "globalThis.__omxInstalledUndeclared = true;",
          "export function setup() {}",
        ].join("\n"),
        { declared: false },
      );

      await initIntegrations(makeApp(), [installed()]);

      expect(g.__omxInstalledUndeclared).toBeUndefined();
      expect(getIntegration("demo")?.loadState).toBe("loaded");
    });

    describe("safe mode and the loader gates", () => {
      let runtimeDir: string;

      beforeEach(() => {
        runtimeDir = join(parent, "runtime");
        mkdirSync(runtimeDir);
        initSafeMode({}, runtimeDir);
      });

      afterEach(() => {
        vi.useRealTimers();
        initSafeMode({}, runtimeDir);
        setDisabledExtensionResolver(null);
        setCompatibilityResolver(null);
        getDisabledExtensionMocks().disabledExtensionIntegrationIds.mockClear();
      });

      const recording = (comment: string, extra: string[] = []) =>
        [
          `// ${comment}`,
          "globalThis.__omxInstalledEvaluated = true;",
          "export function setup(ctx) {",
          "  globalThis.__omxInstalledLoaded = true;",
          ...extra,
          "}",
        ].join("\n");

      function writeGatedFixtures(comment: string, extra: string[] = []) {
        writeInstalled("installed-demo", recording(comment, extra), {
          manifest: { name: "Installed Demo", database: { migrations: true } },
        });
        writeBuiltIn(
          "built-in-demo",
          'export function setup(ctx) { ctx.registerRoute("GET", "/ok", (_q, reply) => reply.send({ ok: true })); }\n',
        );
      }

      it("loads no installed code in safe mode and keeps built-ins", async () => {
        writeGatedFixtures("loads no installed code in safe mode and keeps built-ins");
        initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, runtimeDir);
        const app = makeApp();

        await initIntegrations(app, [installed(), builtIn()]);

        expect(getIntegration("installed-demo")).toMatchObject({
          enabled: false,
          loadState: "safe-mode",
          manifest: { id: "installed-demo", name: "Installed Demo" },
        });
        expect(getIntegration("installed-demo")?.loadError).toBeUndefined();
        expect(g.__omxInstalledEvaluated).toBeUndefined();
        expect(g.__omxInstalledLoaded).toBeUndefined();
        expect(getExtensionMigrationMocks().applyExtensionMigrations).not.toHaveBeenCalled();
        expect(getDisabledExtensionMocks().disabledExtensionIntegrationIds).not.toHaveBeenCalled();
        expect(getIntegration("built-in-demo")?.loadState).toBe("loaded");
        expect((await app.inject("/api/integrations/built-in-demo/ok")).statusCode).toBe(200);
        expect(failedIntegrationLoads(["installed-demo"])).toEqual([]);
      });

      it("marks only the import and setup of installed code in the boot marker", async () => {
        const markerPath = join(runtimeDir, "boot-marker.json");
        const readMarker = () => JSON.parse(fs.readFileSync(markerPath, "utf8") as string);
        g.__omxInstalledMarkerPath = markerPath;
        const recordMarker = (key: string) =>
          `globalThis.${key} = JSON.parse(readFileSync(globalThis.__omxInstalledMarkerPath, "utf8"));`;
        writeInstalled(
          "installed-demo",
          [
            "// marks only the import and setup of installed code in the boot marker",
            'import { readFileSync } from "node:fs";',
            recordMarker("__omxInstalledAtImport"),
            "export function setup() {",
            `  ${recordMarker("__omxInstalledAtSetup")}`,
            "}",
          ].join("\n"),
          { manifest: { database: { migrations: true } } },
        );
        writeBuiltIn("built-in-demo", "export function setup() {}\n");
        const { applyExtensionMigrations } = getExtensionMigrationMocks();
        const atMigration: unknown[] = [];
        applyExtensionMigrations.mockImplementationOnce(async () => {
          atMigration.push(readMarker());
          return { applied: [], schemaAhead: false };
        });
        beginBoot(runtimeDir, new Date());

        await initIntegrations(makeApp(), [builtIn()]);
        expect(readMarker()).toMatchObject({ installedCodeStarted: false, current: null });

        await initIntegrations(makeApp(), [installed(), builtIn()]);
        expect(getIntegration("installed-demo")?.loadError).toBeUndefined();

        // A migration may wait for half an hour; a stop meanwhile is not the code's fault.
        expect(atMigration).toEqual([
          expect.objectContaining({ installedCodeStarted: false, current: null }),
        ]);
        expect(g.__omxInstalledAtImport).toMatchObject({
          installedCodeStarted: true,
          current: { integrationId: "installed-demo", phase: "import" },
        });
        expect(g.__omxInstalledAtSetup).toMatchObject({
          current: { integrationId: "installed-demo", phase: "setup" },
        });
        expect(readMarker()).toMatchObject({
          running: true,
          installedCodeStarted: true,
          current: null,
        });
        expect(getIntegration("installed-demo")?.loadState).toBe("loaded");
      });

      it("stays in safe mode across a reload", async () => {
        writeGatedFixtures("stays in safe mode across a reload");
        writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
        initSafeMode({}, runtimeDir);
        await initIntegrations(makeApp(), [installed(), builtIn()]);

        rmSync(join(runtimeDir, "safe-mode.json"));
        await reloadIntegrations();

        expect(getIntegration("installed-demo")?.loadState).toBe("safe-mode");
        expect(g.__omxInstalledEvaluated).toBeUndefined();
        expect(getIntegration("built-in-demo")?.loadState).toBe("loaded");
      });

      it("starts no task and runs no subject-data handler in safe mode", async () => {
        writeGatedFixtures("starts no task and runs no subject-data handler in safe mode", [
          '  ctx.schedule("refresh", { everyMs: 1000, deadlineMs: 5000 }, async () => {',
          "    globalThis.__omxInstalledRan = true;",
          "  });",
          "  ctx.registerSubjectDataHandler({",
          "    async erase() { globalThis.__omxInstalledErased = true; },",
          "    async export() { return null; },",
          "  });",
        ]);
        initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, runtimeDir);
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

        await initIntegrations(makeApp(), [installed(), builtIn()]);
        vi.advanceTimersByTime(5_000);

        expect(g.__omxInstalledRan).toBeUndefined();
        expect(getTaskRunMocks().store.start).not.toHaveBeenCalled();
        const synced: Array<{ handling: readonly string[]; stopped: readonly string[] }> = [];
        const subjectData = createExtensionSubjectData({
          store: {
            syncHandlers: async (input) => {
              synced.push(input);
              return new Map();
            },
            pendingSubjects: async () => ["u1"],
            eraseLocked: async (_id, _subject, erase) => erase(),
            recordStalled: async () => {},
            pendingSummary: async () => new Map([["installed-demo", { count: 1, attempts: 0 }]]),
            count: async () => 1,
            migrated: async () => new Set(),
          },
          integrations: getAllIntegrations,
          attention: {
            raise: vi.fn(async () => {}),
            resolve: vi.fn(async () => {}),
            openKeys: vi.fn(async () => []),
          },
          log: { warn: vi.fn() },
        });
        await subjectData.syncSubjectHandlerTable();
        // Its handler row stays, so deletions keep being recorded for it.
        expect(synced).toEqual([{ handling: [], stopped: ["built-in-demo"] }]);
        expect(await subjectData.runPendingErasures()).toEqual({ erased: 0, failed: 0 });
        expect(g.__omxInstalledErased).toBeUndefined();
      });

      it("lists no installed integration publicly in safe mode", async () => {
        writeGatedFixtures("lists no installed integration publicly in safe mode");
        initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, runtimeDir);
        const app = makeApp();
        await initIntegrations(app, [installed(), builtIn()]);

        const listed = (await app.inject("/api/integrations")).json() as {
          integrations: Array<{ id: string }>;
        };

        expect(listed.integrations.map(({ id }) => id)).toEqual(["built-in-demo"]);
        expect(getIntegrationsByDomain("knowledge").map(({ id }) => id)).toEqual(["built-in-demo"]);
      });

      it("does not load an integration whose extension is disabled", async () => {
        writeGatedFixtures("does not load an integration whose extension is disabled");
        getDisabledExtensionMocks().disabledExtensionIntegrationIds.mockResolvedValueOnce(
          new Set(["installed-demo"]),
        );

        await initIntegrations(makeApp(), [installed(), builtIn()]);

        expect(getIntegration("installed-demo")).toMatchObject({
          enabled: false,
          loadState: "disabled",
          manifest: { id: "installed-demo" },
        });
        expect(g.__omxInstalledEvaluated).toBeUndefined();
        expect(getExtensionMigrationMocks().applyExtensionMigrations).not.toHaveBeenCalled();
        expect(getIntegration("built-in-demo")?.loadState).toBe("loaded");
      });

      it("keeps the manifest of a disabled integration", async () => {
        writeInstalled("off", recording("keeps the manifest of a disabled integration"), {
          manifest: { name: "Off" },
        });
        setDisabledExtensionResolver(async () => new Set(["off"]));

        await initIntegrations(makeApp(), [installed()]);

        expect(getIntegration("off")).toMatchObject({
          loadState: "disabled",
          manifest: { id: "off", name: "Off", platform: "1.0" },
        });
        expect(getDisabledExtensionMocks().disabledExtensionIntegrationIds).not.toHaveBeenCalled();
      });

      it("loads an integration again once its extension is enabled and the host reloads", async () => {
        writeInstalled(
          "demo",
          recording("loads an integration again once its extension is enabled"),
        );
        let disabled = new Set(["demo"]);
        setDisabledExtensionResolver(async () => disabled);
        await initIntegrations(makeApp(), [installed()]);
        expect(getIntegration("demo")?.loadState).toBe("disabled");

        disabled = new Set();
        await reloadIntegrations();

        expect(getIntegration("demo")?.loadState).toBe("loaded");
        expect(g.__omxInstalledLoaded).toBe(true);
      });

      it("records an incompatible integration instead of skipping it", async () => {
        writeInstalled("demo", recording("records an incompatible integration"));
        setCompatibilityResolver((manifest) =>
          manifest.id === "demo" ? { reason: "platform", required: "2.0" } : null,
        );

        await initIntegrations(makeApp(), [installed()]);

        expect(getIntegration("demo")).toMatchObject({
          enabled: false,
          loadState: "incompatible",
          manifest: { id: "demo" },
          loadError: { phase: "import", message: "requires platform 2.0, this is 1.0" },
        });
        expect(g.__omxInstalledEvaluated).toBeUndefined();
      });

      it("names the web platform when that is what is missing", async () => {
        writeInstalled("demo", recording("names the web platform"));
        setCompatibilityResolver(() => ({ reason: "webPlatform", required: "2.0" }));

        await initIntegrations(makeApp(), [installed()]);

        expect(getIntegration("demo")).toMatchObject({
          loadState: "incompatible",
          loadError: { message: "requires web platform 2.0, this is 1.0" },
        });
      });

      it("refuses an installed manifest that needs a newer platform by default", async () => {
        writeInstalled("demo", recording("refuses a newer platform by default"), {
          manifest: { platform: "1.9" },
        });
        writeBuiltIn("built-in-demo", "export function setup() {}\n");

        await initIntegrations(makeApp(), [installed(), builtIn()]);

        expect(getIntegration("demo")).toMatchObject({
          loadState: "incompatible",
          loadError: { phase: "import", message: "requires platform 1.9, this is 1.0" },
        });
        expect(getIntegration("built-in-demo")?.loadState).toBe("loaded");
      });

      it("asks the compatibility resolver once for each installed manifest", async () => {
        writeInstalled("a", recording("asks the compatibility resolver once: a"));
        writeInstalled("b", recording("asks the compatibility resolver once: b"));
        writeBuiltIn("built-in-demo", "export function setup() {}\n");
        const resolver = vi.fn((_manifest: { id: string }) => null);
        setCompatibilityResolver(resolver);

        await initIntegrations(makeApp(), [installed(), builtIn()]);

        expect(resolver.mock.calls.map(([manifest]) => manifest.id).sort()).toEqual(["a", "b"]);
      });

      it("loads no installed integration when the disabled set cannot be read", async () => {
        writeGatedFixtures("loads no installed integration when the disabled set cannot be read");
        setDisabledExtensionResolver(async () => {
          throw new Error("db down");
        });
        vi.useFakeTimers({ toFake: ["setTimeout"] });

        const booting = initIntegrations(makeApp(), [installed(), builtIn()]);
        await vi.advanceTimersByTimeAsync(5_000);
        await booting;

        expect(getIntegration("installed-demo")).toMatchObject({
          enabled: false,
          loadState: "failed",
          loadError: { phase: "platform", message: "could not read extension state" },
        });
        expect(g.__omxInstalledEvaluated).toBeUndefined();
        expect(getIntegration("built-in-demo")?.loadState).toBe("loaded");
        expect(failedIntegrationLoads(["installed-demo"])).toEqual([
          { id: "installed-demo", phase: "platform", message: "could not read extension state" },
        ]);
      });

      it("loads no installed integration when the compatibility rule throws", async () => {
        writeGatedFixtures("loads no installed integration when the compatibility rule throws");
        setCompatibilityResolver(() => {
          throw new Error("broken rule");
        });
        vi.useFakeTimers({ toFake: ["setTimeout"] });

        const booting = initIntegrations(makeApp(), [installed(), builtIn()]);
        await vi.advanceTimersByTimeAsync(5_000);
        await booting;

        expect(getIntegration("installed-demo")).toMatchObject({
          loadState: "failed",
          loadError: { phase: "platform", message: "could not read extension state" },
        });
        expect(getIntegration("built-in-demo")?.loadState).toBe("loaded");
      });

      it("retries the gates once at boot", async () => {
        writeGatedFixtures("retries the gates once at boot");
        const resolver = vi
          .fn<() => Promise<ReadonlySet<string>>>()
          .mockRejectedValueOnce(new Error("db starting"))
          .mockResolvedValueOnce(new Set());
        setDisabledExtensionResolver(resolver);
        vi.useFakeTimers({ toFake: ["setTimeout"] });

        let settled = false;
        const booting = initIntegrations(makeApp(), [installed(), builtIn()]).then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(settled).toBe(false);
        expect(resolver).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await booting;

        expect(resolver).toHaveBeenCalledTimes(2);
        expect(getIntegration("installed-demo")?.loadState).toBe("loaded");
        expect(g.__omxInstalledLoaded).toBe(true);
      });

      it("does not retry the gates on a reload", async () => {
        writeGatedFixtures("does not retry the gates on a reload");
        await initIntegrations(makeApp(), [installed(), builtIn()]);
        const resolver = vi.fn(async (): Promise<ReadonlySet<string>> => {
          throw new Error("db down");
        });
        setDisabledExtensionResolver(resolver);

        await reloadIntegrations();

        expect(resolver).toHaveBeenCalledTimes(1);
        expect(getIntegration("installed-demo")).toMatchObject({
          loadState: "failed",
          loadError: { phase: "platform", message: "could not read extension state" },
        });
        expect(getIntegration("built-in-demo")?.loadState).toBe("loaded");
      });

      it("lets only the place links of an operator-disabled extension fall back to coordinates", async () => {
        writeInstalled("held-safe", recording("held back: safe mode"));
        initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, runtimeDir);
        await initIntegrations(makeApp(), [installed()]);
        expect(getIntegration("held-safe")?.loadState).toBe("safe-mode");
        // A transient hold keeps refusing a substitute place, which would be
        // cached under the extension's id after it loads again.
        expect(isEnabledIntegrationScheme("held-safe")).toBe(true);

        initSafeMode({}, runtimeDir);
        writeInstalled("held-disabled", recording("held back: disabled"));
        writeInstalled("held-incompatible", recording("held back: incompatible"));
        writeInstalled(
          "loads-and-throws",
          "export function setup() { throw new Error('boom'); }\n",
        );
        setDisabledExtensionResolver(async () => new Set(["held-disabled"]));
        setCompatibilityResolver((manifest) =>
          manifest.id === "held-incompatible" ? { reason: "platform", required: "9.0" } : null,
        );
        await reloadIntegrations();
        expect(getIntegration("held-disabled")?.loadState).toBe("disabled");
        expect(getIntegration("held-incompatible")?.loadState).toBe("incompatible");
        expect(isEnabledIntegrationScheme("held-disabled")).toBe(false);
        expect(isEnabledIntegrationScheme("held-incompatible")).toBe(true);
        // Code that ran and failed keeps refusing a substitute place.
        expect(getIntegration("loads-and-throws")?.loadState).toBe("failed");
        expect(isEnabledIntegrationScheme("loads-and-throws")).toBe(true);

        setDisabledExtensionResolver(async () => {
          throw new Error("db down");
        });
        await reloadIntegrations();
        expect(getIntegration("held-safe")).toMatchObject({
          loadState: "failed",
          loadError: { message: "could not read extension state" },
        });
        expect(isEnabledIntegrationScheme("held-safe")).toBe(true);
      });

      it("marks what safe mode held back as failed when the reload after leaving it fails", async () => {
        writeGatedFixtures("marks what safe mode held back as failed");
        initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, runtimeDir);
        await initIntegrations(makeApp(), [installed(), builtIn()]);

        markSafeModeRecordsFailed("disk full");

        expect(getIntegration("installed-demo")).toMatchObject({
          enabled: false,
          loadState: "failed",
          loadError: {
            phase: "platform",
            message: "not loaded: the reload after leaving safe mode failed (disk full)",
          },
        });
        expect(getIntegration("built-in-demo")?.loadState).toBe("loaded");
      });

      it("bounds a resolver that never settles", async () => {
        writeGatedFixtures("bounds a resolver that never settles");
        setDisabledExtensionResolver(() => new Promise<ReadonlySet<string>>(() => {}));
        vi.useFakeTimers({ toFake: ["setTimeout"] });

        let settled = false;
        const booting = initIntegrations(makeApp(), [installed(), builtIn()]).then(() => {
          settled = true;
        });
        // Ten seconds for each read, five between the boot's two attempts.
        await vi.advanceTimersByTimeAsync(24_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        // Fails in two seconds, not at the test timeout, when the bound is gone.
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2_000 });
        await booting;

        expect(getIntegration("installed-demo")).toMatchObject({
          enabled: false,
          loadState: "failed",
          loadError: { phase: "platform", message: "could not read extension state" },
        });
        expect(g.__omxInstalledEvaluated).toBeUndefined();
        expect(getIntegration("built-in-demo")?.loadState).toBe("loaded");

        setDisabledExtensionResolver(() => new Promise<ReadonlySet<string>>(() => {}));
        let reloaded = false;
        const reloading = reloadIntegrations().then(() => {
          reloaded = true;
        });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(reloaded).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await reloading;
        expect(getIntegration("installed-demo")?.loadState).toBe("failed");
      });

      it("starts in safe mode while the secrets key is unusable", async () => {
        writeInstalled(
          "installed-secret",
          recording("starts in safe mode while the secrets key is unusable"),
          {
            manifest: {
              name: "Installed Secret",
              configSchema: {
                properties: { apiKey: { type: "string", "x-openmapx-secret": true } },
              },
            },
          },
        );
        vi.mocked(secretsKeyProblem).mockReturnValue("The secrets key is not configured");
        initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, runtimeDir);

        await expect(initIntegrations(makeApp(), [installed()])).resolves.toBeUndefined();

        expect(getIntegration("installed-secret")).toMatchObject({
          enabled: false,
          loadState: "safe-mode",
        });
        expect(g.__omxInstalledEvaluated).toBeUndefined();
      });

      it("tells an install job which integrations did not load and which are held back", async () => {
        writeInstalled("off", recording("tells an install job: off"));
        writeInstalled("old", recording("tells an install job: old"));
        writeInstalled("fine", recording("tells an install job: fine"));
        setDisabledExtensionResolver(async () => new Set(["off"]));
        setCompatibilityResolver((manifest) =>
          manifest.id === "old" ? { reason: "platform", required: "2.0" } : null,
        );
        await initIntegrations(makeApp(), [installed()]);

        const ids = ["off", "old", "fine", "gone"];
        expect(failedIntegrationLoads(ids)).toEqual([
          { id: "old", phase: "import", message: "requires platform 2.0, this is 1.0" },
          { id: "gone", phase: "import", message: "the reload did not find it" },
        ]);
        expect(heldBackIntegrationLoads(ids)).toEqual([
          {
            id: "off",
            loadState: "disabled",
            message: "Integration off is installed but not loaded: its extension is disabled.",
          },
        ]);

        initSafeMode({ OPENMAPX_SAFE_MODE: "1" }, runtimeDir);
        await reloadIntegrations();

        expect(failedIntegrationLoads(ids)).toEqual([
          { id: "gone", phase: "import", message: "the reload did not find it" },
        ]);
        expect(heldBackIntegrationLoads(["fine"])).toEqual([
          {
            id: "fine",
            loadState: "safe-mode",
            message:
              "Integration fine is installed but not loaded: the API runs in safe mode. It loads when safe mode is left.",
          },
        ]);
      });

      it("reads no extension state without installed integrations", async () => {
        writeBuiltIn("built-in-demo", "export function setup() {}\n");
        const resolver = vi.fn(async () => new Set<string>());
        setDisabledExtensionResolver(resolver);

        await initIntegrations(makeApp(), [installed(), builtIn()]);

        expect(resolver).not.toHaveBeenCalled();
      });
    });
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
    // component id grammar and fails validateManifest.
    expect(getIntegration("BROKEN")).toBeUndefined();
    // The host must have warned about the broken manifest.
    const warnCalls = warnMock.mock.calls.flat().join(" ");
    expect(warnCalls).toMatch(/BROKEN|skip/i);
  });

  it("secret-needer loads when the secrets key is configured", async () => {
    // Confirm that the fixture directory containing secret-needer loads without
    // error when the secrets key is usable (the default in this suite).
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    expect(getAllIntegrations().some((i) => i.id === "secret-needer")).toBe(true);
  });

  it("throws at boot with the reason when a manifest declares vault secrets but the secrets key is unusable", async () => {
    const reason =
      "Secrets key file must have mode 0444 (OPENMAPX_SECRETS_KEY_FILE). It must hold 32 random bytes";
    vi.mocked(secretsKeyProblem).mockReturnValue(reason);

    const app = makeApp();

    const boot = initIntegrations(app, [FIXTURES_DIR]);
    await expect(boot).rejects.toThrow(/secrets key is not usable.*secret-needer/);
    await expect(boot).rejects.toThrow(reason);
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
    // A community manifest may not call itself built-in, so the fixture is relabelled.
    const parent = mkdtempSync(join(tmpdir(), "omx-community-preview-"));
    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "alpha", "manifest.json"), "utf-8"));
    const directory = writeTestIntegration(parent, "alpha", { ...fixture, quality: "community" });
    copyFileSync(join(FIXTURES_DIR, "alpha", "preview.svg"), join(directory, "preview.svg"));
    try {
      await initIntegrations(app, [{ directory: parent, isBuiltIn: false }]);

      const response = await app.inject({ method: "GET", url: "/api/integrations/alpha/preview" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
      expect(response.body).toBe(readFileSync(join(FIXTURES_DIR, "alpha", "preview.svg"), "utf-8"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Step 4: Reload and shutdown tests
// ---------------------------------------------------------------------------

describe("resolved service cache identity", () => {
  it("captures immutable bindings for initial and reloaded provider generations", async () => {
    const service = { serviceId: "photon", url: "https://first.example", enabled: true };
    vi.mocked(resolveRequiresForIntegration).mockReturnValue(new Map([["geocoder", service]]));
    const app = makeApp();
    try {
      await initIntegrations(app, [FIXTURES_DIR]);
      const initial = getIntegration("alpha");
      expect(initial?.resolvedServices?.geocoder?.url).toBe("https://first.example");
      service.url = "https://second.example";
      expect(initial?.resolvedServices?.geocoder?.url).toBe("https://first.example");
      expect(Object.isFrozen(initial?.resolvedServices)).toBe(true);
      expect(Object.isFrozen(initial?.resolvedServices?.geocoder)).toBe(true);
      await reloadIntegrations();
      expect(getIntegration("alpha")?.resolvedServices?.geocoder?.url).toBe(
        "https://second.example",
      );
      expect(initial?.resolvedServices?.geocoder?.url).toBe("https://first.example");
    } finally {
      vi.mocked(resolveRequiresForIntegration).mockReturnValue(new Map());
      await app.close();
    }
  });
});

describe("operator-set provider order", () => {
  const contexts = new Map<string, IntegrationContext>();
  const scope = globalThis as typeof globalThis & {
    __omxOrderContexts?: Map<string, IntegrationContext>;
    __omxOrderDuringSetup?: readonly string[];
  };
  let root: string;

  beforeEach(() => {
    contexts.clear();
    scope.__omxOrderContexts = contexts;
    scope.__omxOrderDuringSetup = undefined;
    root = mkdtempSync(join(tmpdir(), "omx-provider-order-"));
  });

  afterEach(() => {
    scope.__omxOrderContexts = undefined;
    scope.__omxOrderDuringSetup = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  function integration(
    id: string,
    domains: string[],
    options: {
      config?: Record<string, unknown>;
      setup?: string;
      configSchema?: Record<string, unknown>;
    } = {},
  ): void {
    const directory = writeTestIntegration(root, id, {
      id,
      version: "1.0.0",
      author: "Test",
      platform: "1.0",
      domains,
      quality: "built-in",
      configSchema: options.configSchema ?? {
        properties: {
          providerOrder: { type: "array", items: { type: "string" }, maxItems: 64, default: [] },
        },
      },
    });
    if (options.config) {
      writeFileSync(join(directory, "config.json"), JSON.stringify(options.config));
    }
    writeFileSync(
      join(directory, "index.js"),
      [
        "export function setup(ctx) {",
        `  globalThis.__omxOrderContexts.set(${JSON.stringify(id)}, ctx);`,
        options.setup ?? "",
        "}",
      ].join("\n"),
    );
  }

  const ctxOf = (id: string): IntegrationContext => {
    const ctx = contexts.get(id);
    if (!ctx) throw new Error(`no context captured for ${id}`);
    return ctx;
  };

  it("returns the stored order while the owning integration is disabled", async () => {
    integration("overlay-live-transit", ["live-transit"], {
      config: { enabled: false, providerOrder: ["live-transit-acme"] },
    });
    integration("transit", ["transit"]);
    await initIntegrations(makeApp(), [{ directory: root, isBuiltIn: true }]);

    expect(getIntegration("overlay-live-transit")?.enabled).toBe(false);
    expect(ctxOf("transit").getProviderOrder("live-transit")).toEqual(["live-transit-acme"]);
  });

  it("returns an empty order for a domain without an orchestrator", async () => {
    integration("transit", ["transit"]);
    await initIntegrations(makeApp(), [{ directory: root, isBuiltIn: true }]);

    expect(ctxOf("transit").getProviderOrder("hazards")).toEqual([]);
    expect(ctxOf("transit").getProviderOrder("no-such-domain")).toEqual([]);
  });

  it("reads the order before the owning integration is set up", async () => {
    integration("air-quality", ["air-quality"], { config: { providerOrder: ["aq-first"] } });
    integration("aaa-asker", ["transit"], {
      setup: '  globalThis.__omxOrderDuringSetup = ctx.getProviderOrder("air-quality");',
    });
    await initIntegrations(makeApp(), [{ directory: root, isBuiltIn: true }]);
    expect(scope.__omxOrderDuringSetup).toEqual(["aq-first"]);

    await reloadIntegrations();
    expect(scope.__omxOrderDuringSetup).toEqual(["aq-first"]);
  });

  it("picks up a changed stored order on reload, also while the owner is disabled", async () => {
    integration("fuel", ["data-source"], { config: { providerOrder: ["a", "b"] } });
    integration("transit", ["transit"]);
    await initIntegrations(makeApp(), [{ directory: root, isBuiltIn: true }]);
    expect(ctxOf("transit").getProviderOrder("fuel-stations")).toEqual(["a", "b"]);
    expect(getProviderOrder("fuel-stations")).toEqual(["a", "b"]);

    writeFileSync(join(root, "fuel", "config.json"), JSON.stringify({ providerOrder: ["b"] }));
    await reloadIntegrations();
    expect(ctxOf("transit").getProviderOrder("fuel-stations")).toEqual(["b"]);
    expect(getProviderOrder("fuel-stations")).toEqual(["b"]);

    writeFileSync(
      join(root, "fuel", "config.json"),
      JSON.stringify({ enabled: false, providerOrder: ["c"] }),
    );
    await reloadIntegrations();
    expect(getIntegration("fuel")?.enabled).toBe(false);
    expect(ctxOf("transit").getProviderOrder("fuel-stations")).toEqual(["c"]);
    expect(getProviderOrder("fuel-stations")).toEqual(["c"]);
  });

  it.each([
    ["config.json", "config"],
    ["env", "env"],
  ] as const)(
    "cuts an over-long order from %s to 64 entries with one warning",
    async (source, via) => {
      const long = Array.from({ length: 70 }, (_, index) => `p${index}`);
      integration("fuel", ["data-source"], {
        config: via === "config" ? { providerOrder: [...long, 7, "p0"] } : { providerOrder: ["x"] },
      });
      integration("transit", ["transit"]);
      if (via === "env") vi.stubEnv("INTEGRATION_FUEL_PROVIDER_ORDER", long.join(","));
      const warn = vi.spyOn(processLogger, "warn").mockImplementation(() => undefined);
      try {
        await initIntegrations(makeApp(), [{ directory: root, isBuiltIn: true }]);
        expect(ctxOf("transit").getProviderOrder("fuel-stations")).toEqual(long.slice(0, 64));
        const cuts = warn.mock.calls.filter(([, message]) =>
          String(message).includes("providerOrder"),
        );
        expect(cuts).toEqual([
          [
            expect.objectContaining({ integrationId: "fuel", source }),
            expect.stringContaining("only the first 64"),
          ],
        ]);
      } finally {
        warn.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("serves routing in the routing manifest's default order, as fingerprinted and listed", async () => {
    const routingManifest = JSON.parse(
      readFileSync(
        join(fileURLToPath(import.meta.url), "../../../../integrations/routing/manifest.json"),
        "utf8",
      ),
    ) as { configSchema: { properties: { providerOrder: { default: string[] } } } };
    const defaultOrder = routingManifest.configSchema.properties.providerOrder.default;
    integration("routing", ["routing"], {
      configSchema: {
        properties: { providerOrder: routingManifest.configSchema.properties.providerOrder },
      },
    });
    for (const [id, priority] of [
      ["routing-acme", 1],
      ["routing-osrm", 20],
      ["routing-valhalla", 10],
      ["routing-brouter", 5],
    ] as const) {
      integration(id, ["routing"], {
        setup: [
          "  ctx.registerRoutingProvider({",
          `    id: ${JSON.stringify(id)}, priority: ${priority}, supportedModes: ["driving"],`,
          "    getRoute: async () => ({ waypoints: [], routes: [], activeRouteIndex: 0 }),",
          "  });",
        ].join("\n"),
      });
    }
    await initIntegrations(makeApp(), [{ directory: root, isBuiltIn: true }]);

    const ctx = ctxOf("routing");
    expect(getProviderOrder("routing")).toEqual(defaultOrder);
    expect(ctx.getProviderOrder("routing")).toEqual(defaultOrder);
    const served = collectOrderedProviders(ctx, "routing").map((entry) => entry.integrationId);
    expect(served).toEqual(["routing-brouter", "routing-valhalla", "routing-osrm", "routing-acme"]);
    expect(
      effectiveProviderOrder(defaultOrder, getIntegrationsByDomain("routing"), "routing").map(
        (entry) => entry.integrationId,
      ),
    ).toEqual(served);
    expect(ctx.getProviderOrderFingerprint("routing")).toBe(
      createHash("sha256")
        .update(JSON.stringify(served.map((id) => [id, id])))
        .digest("hex")
        .slice(0, 16),
    );
  });

  it("fingerprints the integrations that serve a domain", async () => {
    integration("transit", ["transit"]);
    integration("asker", ["weather"], {
      setup: [
        "  ctx.registerWeatherProvider({",
        "    id: 'asker-weather', priority: 1, getCurrentWeather: async () => null,",
        "  });",
      ].join("\n"),
    });
    await initIntegrations(makeApp(), [{ directory: root, isBuiltIn: true }]);

    const fingerprint = ctxOf("transit").getProviderOrderFingerprint("weather");
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint).toBe(
      createHash("sha256")
        .update(JSON.stringify([["asker", "asker-weather"]]))
        .digest("hex")
        .slice(0, 16),
    );
    expect(ctxOf("transit").getProviderOrderFingerprint("hazards")).not.toBe(fingerprint);
  });
});

describe("shutdownIntegrations", () => {
  it("after shutdown getAllIntegrations returns an empty array", async () => {
    const app = makeApp();
    await initIntegrations(app, [FIXTURES_DIR]);

    await shutdownIntegrations();

    expect(getAllIntegrations()).toHaveLength(0);
  });
});

describe("integration health refresh", () => {
  afterEach(() => {
    stopIntegrationHealthRefresh();
    vi.useRealTimers();
  });

  it("is not scheduled by loading integrations", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    try {
      await initIntegrations(makeApp(), [FIXTURES_DIR]);

      expect(intervals.mock.calls.filter(([, delay]) => delay === 60_000)).toEqual([]);
      expect(timeouts.mock.calls.filter(([, delay]) => delay === 5_000)).toEqual([]);
    } finally {
      intervals.mockRestore();
      timeouts.mockRestore();
    }
  });

  it("seeds after five seconds, refreshes each minute, and stops when asked", async () => {
    await initIntegrations(makeApp(), [FIXTURES_DIR]);
    vi.useFakeTimers();
    const checks = integrationHealthMocks.executeAllIntegrationHealthChecks;
    checks.mockClear();

    startIntegrationHealthRefresh();
    startIntegrationHealthRefresh();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(checks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(checks).toHaveBeenCalledTimes(2);

    stopIntegrationHealthRefresh();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(checks).toHaveBeenCalledTimes(2);
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
      for (const r of results) {
        expect(r.message).toBe("Integrations reloaded");
        expect(r.reloaded).toBeGreaterThanOrEqual(2);
      }

      // init(1) + in-flight reload(1) + exactly one shared trailing pass(1).
      // A naive per-caller queue would give 4; pure coalescing would give 2.
      expect(g.__omxGateSetupCount).toBe(3);

      const finalIds = getAllIntegrations().map((i) => i.id);
      expect(finalIds).toContain("alpha");
      expect(finalIds).toContain("beta");
      expect(finalIds).toContain("gate-probe");
      const response = await app.inject({ method: "GET", url: "/api/integrations/alpha/hello" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ integration: "alpha" });
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
});
