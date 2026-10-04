/**
 * Runtime data sources: an integration whose manifest sets
 * `runtimeDataSources: true` supplies its source list through
 * `ctx.setDataSources()`. These tests drive the real host and the real
 * data-use policy; only infrastructure (DB, Redis, attribution storage,
 * service registry) is stubbed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationContext, IntegrationDataSource } from "@openmapx/integration-framework";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attribution = vi.hoisted(() => {
  const index = {
    setIntegrationManifests: vi.fn(),
    reload: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  return { index, current: null as typeof index | null };
});

vi.mock("./redis.js", () => ({ redis: null }));

vi.mock("./db/index.js", () => {
  const rows = () => Promise.resolve([]);
  return {
    db: {
      select: () => ({
        from: () => Object.assign(rows(), { where: () => ({ limit: rows }) }),
      }),
    },
    sql: { unsafe: vi.fn().mockResolvedValue([]) },
  };
});

vi.mock("./db/schema.js", () => ({
  integrationConfig: { integrationId: "integrationId", config: "config" },
  integrationSecret: {},
  systemSettings: {},
}));

vi.mock("./services/attribution/index.js", () => ({
  AttributionIndex: { init: vi.fn(async () => attribution.index) },
  defaultMotisLicenseFile: vi.fn().mockReturnValue(null),
  getAttributionIndex: () => attribution.current,
  setAttributionIndex: (idx: typeof attribution.index | null) => {
    attribution.current = idx;
  },
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
  getCachedIntegrationHealthSnapshot: vi.fn().mockReturnValue({ updatedAt: null, results: [] }),
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

vi.mock("./utils/require-auth.js", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@openmapx/poi-source-registry", () => ({
  beginPoiSourceRegistryStaging: vi.fn(),
  commitPoiSourceRegistryStaging: vi.fn(),
  registerPoiSources: vi.fn(),
  rollbackPoiSourceRegistryStaging: vi.fn(),
}));

import {
  getIntegration,
  initIntegrations,
  reloadIntegrations,
  setIntegrationSourcesChangedHook,
  shutdownIntegrations,
} from "./integration-host.js";
import {
  getGatedSourceIdsSync,
  invalidateDataUsePolicy,
  refreshDataUsePolicy,
} from "./services/data-use-policy.js";

type ProbeGlobals = {
  __runtimeCtx?: IntegrationContext;
  __staticCtx?: IntegrationContext;
  __runtimeSources?: IntegrationDataSource[];
};
const probe = globalThis as ProbeGlobals;

const source = (sourceId: string, extra: Partial<IntegrationDataSource> = {}) =>
  ({
    sourceId,
    name: sourceId.toUpperCase(),
    url: "https://source.example",
    license: "CC0-1.0",
    providerCountry: "NL",
    providerPrivacyUrl: "https://source.example/privacy",
    endUserExposure: "server-only",
    domain: "road-conditions",
    ...extra,
  }) as IntegrationDataSource;

function writeIntegration(
  parent: string,
  id: string,
  manifest: Record<string, unknown>,
  ctxKey: string,
) {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ id, version: "1.0.0", license: "MIT", quality: "built-in", ...manifest }),
  );
  writeFileSync(
    join(dir, "index.js"),
    [
      "export function setup(ctx) {",
      `  globalThis.${ctxKey} = ctx;`,
      "  if (ctx.manifest.runtimeDataSources && globalThis.__runtimeSources) {",
      "    ctx.setDataSources(globalThis.__runtimeSources);",
      "  }",
      "}",
    ].join("\n"),
  );
}

let parent: string;
let app: FastifyInstance;

async function servedSources(id: string): Promise<string[]> {
  const res = await app.inject("/api/integrations");
  const entry = (
    res.json() as { integrations: Array<{ id: string; dataSources?: IntegrationDataSource[] }> }
  ).integrations.find((i) => i.id === id);
  return (entry?.dataSources ?? []).map((ds) => ds.sourceId);
}

function lastIndexedSourceIds(): string[] {
  const calls = attribution.index.setIntegrationManifests.mock.calls;
  const last = calls.at(-1)?.[0] as Array<{ sourceId: string }> | undefined;
  return (last ?? []).map((row) => row.sourceId);
}

beforeEach(async () => {
  vi.stubEnv("OPENMAPX_ALLOW_NONCOMMERCIAL", "false");
  vi.stubEnv("OPENMAPX_ALLOW_GREY_AREA", "");
  setIntegrationSourcesChangedHook(() => {
    invalidateDataUsePolicy();
    void refreshDataUsePolicy();
  });
  parent = mkdtempSync(join(tmpdir(), "omx-runtime-sources-"));
  writeIntegration(
    parent,
    "runtime-probe",
    { domains: ["road-conditions", "fuel-stations"], runtimeDataSources: true },
    "__runtimeCtx",
  );
  writeIntegration(
    parent,
    "static-probe",
    { domains: ["road-conditions"], dataSources: [source("xx-static-events")] },
    "__staticCtx",
  );
  app = Fastify({ logger: false });
  await initIntegrations(app, [{ directory: parent, isBuiltIn: true }]);
  await refreshDataUsePolicy();
});

afterEach(async () => {
  await shutdownIntegrations();
  rmSync(parent, { recursive: true, force: true });
  probe.__runtimeCtx = undefined;
  probe.__staticCtx = undefined;
  probe.__runtimeSources = undefined;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("ctx.setDataSources", () => {
  it("setDataSources replaces the live list that /api/integrations serves", async () => {
    expect(await servedSources("runtime-probe")).toEqual([]);
    probe.__runtimeCtx?.setDataSources([source("nl-ndw-events"), source("de-autobahn-events")]);
    expect(await servedSources("runtime-probe")).toEqual(["nl-ndw-events", "de-autobahn-events"]);
    probe.__runtimeCtx?.setDataSources([source("fi-digitraffic-events")]);
    expect(await servedSources("runtime-probe")).toEqual(["fi-digitraffic-events"]);
    expect(getIntegration("runtime-probe")?.manifest.dataSources?.map((d) => d.sourceId)).toEqual([
      "fi-digitraffic-events",
    ]);
  });

  it("setDataSources drops an invalid source and keeps the rest", async () => {
    const warn = vi.spyOn(app.log, "warn");
    probe.__runtimeCtx?.setDataSources([
      source("nl-ndw-events"),
      source("xx-no-licence-events", { license: "" }),
      source("xx-foreign-domain-events", { domain: "weather" }),
      source("nl-ndw-events", { name: "Duplicate" }),
    ]);
    expect(await servedSources("runtime-probe")).toEqual(["nl-ndw-events"]);
    const warnings = warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(warnings).toMatch(/xx-no-licence-events/);
    expect(warnings).toMatch(/xx-foreign-domain-events/);
    expect(warnings).toMatch(/nl-ndw-events/);
  });

  it("setDataSources returns the sources the host accepted", () => {
    const accepted = probe.__runtimeCtx?.setDataSources([
      source("nl-ndw-events"),
      source("xx-no-homepage-events", { url: "" }),
    ]);
    expect(accepted?.map((d) => d.sourceId)).toEqual(["nl-ndw-events"]);
  });

  it("setDataSources drops a sourceId another live integration declares, naming both", async () => {
    const warn = vi.spyOn(app.log, "warn");
    const accepted = probe.__runtimeCtx?.setDataSources([
      source("nl-ndw-events"),
      source("xx-static-events"),
    ]);
    expect(accepted?.map((d) => d.sourceId)).toEqual(["nl-ndw-events"]);
    expect(await servedSources("runtime-probe")).toEqual(["nl-ndw-events"]);
    expect(await servedSources("static-probe")).toEqual(["xx-static-events"]);
    const warning = warn.mock.calls
      .map((call) => call.map(String).join(" "))
      .find((line) => line.includes("xx-static-events"));
    expect(warning).toMatch(/runtime-probe/);
    expect(warning).toMatch(/static-probe/);
  });

  it("setDataSources refreshes the attribution index and the data-use policy", async () => {
    expect(getGatedSourceIdsSync().has("xx-nc-events")).toBe(false);
    probe.__runtimeCtx?.setDataSources([
      source("nl-ndw-events", { commercialUse: "yes" }),
      source("xx-nc-events", { commercialUse: "no" }),
    ]);
    await vi.waitFor(() => {
      expect(lastIndexedSourceIds()).toEqual(
        expect.arrayContaining(["xx-static-events", "nl-ndw-events", "xx-nc-events"]),
      );
      expect(attribution.index.reload).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(getGatedSourceIdsSync().has("xx-nc-events")).toBe(true);
    });
    expect(getGatedSourceIdsSync().has("nl-ndw-events")).toBe(false);
  });

  it("setDataSources throws for an integration without runtimeDataSources", () => {
    expect(() => probe.__staticCtx?.setDataSources([source("xx-other-events")])).toThrow(
      /runtimeDataSources/,
    );
    expect(getIntegration("static-probe")?.manifest.dataSources?.map((d) => d.sourceId)).toEqual([
      "xx-static-events",
    ]);
  });

  it("setDataSources throws a descriptive error for a list that is not an array", async () => {
    probe.__runtimeCtx?.setDataSources([source("nl-ndw-events")]);
    expect(probe.__runtimeCtx).toBeDefined();
    expect(() =>
      probe.__runtimeCtx!.setDataSources({ sources: [] } as unknown as IntegrationDataSource[]),
    ).toThrow("Integration runtime-probe: setDataSources expects an array");
    expect(await servedSources("runtime-probe")).toEqual(["nl-ndw-events"]);
  });
});

describe("runtime data sources across a reload", () => {
  it("serves and indexes the list the new generation supplies, never the retired one", async () => {
    probe.__runtimeCtx?.setDataSources([source("nl-ndw-events")]);
    expect(await servedSources("runtime-probe")).toEqual(["nl-ndw-events"]);

    probe.__runtimeSources = [source("de-autobahn-events")];
    await reloadIntegrations();

    expect(await servedSources("runtime-probe")).toEqual(["de-autobahn-events"]);
    expect(lastIndexedSourceIds()).toContain("de-autobahn-events");
    expect(lastIndexedSourceIds()).not.toContain("nl-ndw-events");
  });

  it("starts from an empty list when the new generation has not supplied one yet", async () => {
    probe.__runtimeCtx?.setDataSources([source("nl-ndw-events")]);
    await reloadIntegrations();
    expect(await servedSources("runtime-probe")).toEqual([]);
    expect(lastIndexedSourceIds()).not.toContain("nl-ndw-events");
  });
});
