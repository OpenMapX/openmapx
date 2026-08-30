import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { setup as setupAirQuality } from "@integrations/air-quality";
import type {
  AirQualityProvider,
  IntegrationManifest,
  LoadedIntegration,
} from "@openmapx/integration-framework";
import { validateManifest } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  evidence,
  integration as providerIntegration,
} from "../../../../../integrations/air-quality/__tests__/fixtures.js";

vi.mock("../../utils/require-auth.js", () => ({
  requireAuth: vi.fn().mockRejectedValue(new Error("requireAuth should not be called")),
}));

import {
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
} from "../../integration-routes.js";
import { buildTestApp } from "../../test/app.js";

const AIR_QUALITY_DIR = join(
  fileURLToPath(import.meta.url),
  "../../../../../../integrations/air-quality",
);
const NOW = "2026-08-30T12:00:00.000Z";

function manifest(): IntegrationManifest {
  const raw = JSON.parse(readFileSync(join(AIR_QUALITY_DIR, "manifest.json"), "utf8"));
  const result = validateManifest(raw);
  if (!result.valid) throw new Error(result.errors.join(", "));
  return raw as IntegrationManifest;
}

function modeledProvider(): AirQualityProvider {
  return {
    id: "inject-provider",
    sourceIds: ["inject-source"],
    priority: 50,
    capabilities: new Set(["current", "pollutants"]),
    coverage: { bbox: [-180, -90, 180, 90] },
    async getCurrent() {
      return [
        evidence({
          at: NOW,
          providerId: "inject-provider",
          sourceId: "inject-source",
          value: 55,
        }),
      ];
    },
  };
}

async function plugin(fastify: FastifyInstance): Promise<void> {
  const canonicalManifest = manifest();
  const canonical: LoadedIntegration = {
    id: "air-quality",
    manifest: canonicalManifest,
    config: {},
    directory: AIR_QUALITY_DIR,
    isBuiltIn: true,
    enabled: true,
    providers: new Map(),
    strings: {},
    shutdownHandlers: [],
  };
  const provider = providerIntegration(modeledProvider());
  const ctx = createMockIntegrationContext({
    id: "air-quality",
    manifest: canonicalManifest,
  });
  Object.assign(ctx, {
    getIntegrationsByDomain: () => [provider],
    registerRoute: (
      method: string,
      path: string,
      handler: Parameters<typeof registerIntegrationRoute>[3],
      options?: Parameters<typeof registerIntegrationRoute>[4],
    ) => registerIntegrationRoute("air-quality", method, path, handler, options),
  });
  setupAirQuality(ctx);
  registerIntegrationRouteDispatcher(fastify, new Map([["air-quality", canonical]]));
}

describe("canonical air quality over the production dispatcher", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetIntegrationRoutes();
    app = await buildTestApp(plugin as FastifyPluginAsync);
  });

  afterEach(async () => {
    await app.close();
    resetIntegrationRoutes();
    vi.useRealTimers();
  });

  it("serializes a representative current envelope with private caching", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/integrations/air-quality/current?lat=52.52&lng=13.405",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, max-age=0");
    expect(response.json()).toMatchObject({
      status: "ok",
      primaryEvidenceId: expect.stringMatching(/^obs_1_/),
      primaryIndexId: expect.stringMatching(/^idx_1_/),
      meta: { providersServed: ["inject-provider"] },
    });
  });

  it("preserves repeated query keys so the scalar boundary rejects them", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/integrations/air-quality/current?lat=52.52&lat=48.1&lng=13.405",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "INVALID_QUERY",
      details: { parameter: "lat" },
    });
  });
});
