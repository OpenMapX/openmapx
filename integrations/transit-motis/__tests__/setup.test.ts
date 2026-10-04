import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import { assertTransitProviderContract } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

const ORIGINAL_MOTIS_URL = process.env.MOTIS_URL;

function registeredProviders(
  options: { config?: Record<string, unknown>; serviceUrl?: string } = {},
) {
  const providers: TransitProvider[] = [];
  const ctx = {
    config: options.config ?? {},
    manifest: { dataSources: [] },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getRequiredService: () => (options.serviceUrl ? { url: options.serviceUrl } : null),
    onActivate: (activate: () => void) => activate(),
    registerTransitProvider: (provider: TransitProvider) => providers.push(provider),
  } as unknown as IntegrationContext;
  setup(ctx);
  return providers;
}

beforeEach(() => {
  delete process.env.MOTIS_URL;
  // The rental-capability probe runs in the background; keep it offline.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
});

afterEach(() => {
  if (ORIGINAL_MOTIS_URL === undefined) delete process.env.MOTIS_URL;
  else process.env.MOTIS_URL = ORIGINAL_MOTIS_URL;
  vi.unstubAllGlobals();
});

describe("transit-motis setup", () => {
  it("serves transit from Transitous when no local MOTIS is configured", () => {
    const providers = registeredProviders();
    expect(providers.map((p) => p.id)).toEqual(["transit-motis-transitous"]);
    const [transitous] = providers;
    expect(transitous.prefix).toBe("mo:");
    expect(transitous.role).toBe("baseline");
    expect(transitous.capabilities.stops).toMatchObject({
      nearby: true,
      bbox: true,
      search: true,
      platforms: true,
      timetable: false,
    });
    expect(transitous.capabilities.routes).toEqual({
      lookup: false,
      forStop: false,
      stops: false,
      geometry: false,
    });
    expect(transitous.getVehicleRadar).toBeDefined();
    expect(transitous.getStopTimetable).toBeUndefined();
    expect(() => assertTransitProviderContract(transitous)).not.toThrow();
  });

  it("keeps Transitous a narrow fallback beside a self-hosted MOTIS", () => {
    const providers = registeredProviders({ serviceUrl: "http://motis:8080" });
    expect(providers.map((p) => p.id)).toEqual(["transit-motis-local", "transit-motis-transitous"]);
    const transitous = providers[1];
    expect(transitous.role).toBe("fallback");
    expect(transitous.capabilities.stops.bbox).toBe(false);
    expect(transitous.getVehicleRadar).toBeUndefined();
    expect(transitous.getStopsInBbox).toBeUndefined();
    for (const provider of providers) {
      expect(() => assertTransitProviderContract(provider)).not.toThrow();
    }
  });

  it("treats MOTIS_URL as a self-hosted MOTIS", () => {
    process.env.MOTIS_URL = "http://motis.internal:8080";
    expect(registeredProviders().map((p) => p.id)).toContain("transit-motis-local");
  });

  it("registers nothing when there is no local MOTIS and hosted Transitous is disabled", () => {
    expect(registeredProviders({ config: { hostedRuntimeFallback: false } })).toEqual([]);
  });
});
