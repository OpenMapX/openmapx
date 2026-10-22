import type { UpstreamRuntime } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import type { RegistryEntry } from "../registry-types";

vi.mock("../fetcher", () => ({
  fetchRegistryEntries: vi.fn(),
  setCache: vi.fn(),
  setGithubToken: vi.fn(),
}));

import { fetchRegistryEntries } from "../fetcher";
import { hafasMgateAdapter } from "../hafas-mgate";
import { setup } from "../index";
import { RegistryManager, registry } from "../registry";
export const entry: RegistryEntry = {
  id: "ee/peatus-otp",
  slug: "peatus",
  prefix: "peatus:",
  name: "Peatus",
  protocol: "otpGraphQl",
  supportedLanguages: ["et"],
  timezone: "Europe/Tallinn",
  options: { endpoint: "https://api.peatus.ee/routing/v1/routers/estonia/" },
  coverage: { bbox: [20, 50, 30, 65], tiers: [] },
  attribution: { name: "Peatus", homepage: "https://www.peatus.ee" },
};
const stop = {
  gtfsId: "EE:1",
  name: "Public stop",
  lat: 58,
  lon: 25,
  vehicleMode: "BUS",
  platformCode: null,
  parentStation: null,
};
function shared() {
  return {
    admitSharedRequest: vi.fn(async () => ({ allowed: true, remaining: null })),
    deferSharedRequests: vi.fn(async () => {}),
  } as unknown as UpstreamRuntime;
}
describe("real dynamic OTP setup acquisition", () => {
  it("uses full options, corrected endpoint and captured operator receipts", async () => {
    vi.mocked(fetchRegistryEntries).mockResolvedValue([structuredClone(entry)]);
    const http = fakeHttpClient(() => ({ data: { stops: [stop] } }));
    const ctx = createMockIntegrationContext({ id: "transit-dynamic-registry", http });
    ctx.upstreamRuntime = shared();
    await setup(ctx);
    try {
      const result = await ctx.registered.transit[0].searchStopsByName!("Public", 10);
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0].url).toBe(
        "https://api.peatus.ee/routing/v1/routers/estonia/index/graphql",
      );
      expect(result.data[0]).toMatchObject({
        id: "peatus:EE:1",
        name: "Public stop",
        lat: 58,
        lng: 25,
        provider: "peatus",
      });
      expect(result.attributions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceId: "dyn:ee/peatus-otp", name: "Peatus" }),
        ]),
      );
    } finally {
      registry.stopRefresh();
    }
  });
  it("captures detached immutable entries and suppresses duplicate Entur", async () => {
    const original = structuredClone(entry);
    const manager = new RegistryManager(async () => [
      original,
      { ...original, id: "no/entur-otp", prefix: "entur:" },
    ]);
    await manager.initialize();
    const entries = manager.snapshotEntries();
    original.options.endpoint = "https://evil.test";
    expect(entries).toHaveLength(1);
    expect(entries[0].options.endpoint).toBe(entry.options.endpoint);
    expect(Object.isFrozen(entries[0].options)).toBe(true);
  });
});

describe("final setup publication fence", () => {
  it("rechecks source policy after SDK acquisition before wrapping", async () => {
    vi.mocked(fetchRegistryEntries).mockResolvedValue([structuredClone(entry)]);
    const http = fakeHttpClient(() => ({ data: { stops: [stop] } }));
    const ctx = createMockIntegrationContext({ id: "transit-dynamic-registry", http });
    ctx.upstreamRuntime = shared();
    let checks = 0;
    ctx.getDisallowedSourceIds = async () => new Set(++checks >= 5 ? ["peatus"] : []);
    await setup(ctx);
    try {
      await expect(ctx.registered.transit[0].searchStopsByName!("Public", 1)).rejects.toThrow(
        "OTP source denied",
      );
    } finally {
      registry.stopRefresh();
    }
  });
});

describe("captured registry generation", () => {
  it("forwards the full entry to HAFAS without its former debug-summary cast", async () => {
    const original = {
      ...structuredClone(entry),
      id: "de/vbb-hafas-mgate",
      protocol: "hafasMgate" as const,
      options: { endpoint: "https://hafas.test/mgate", auth: { type: "fixture" } },
    };
    vi.mocked(fetchRegistryEntries).mockResolvedValue([original]);
    const search = vi.spyOn(hafasMgateAdapter, "searchByName").mockResolvedValue([]);
    const ctx = createMockIntegrationContext({ id: "transit-dynamic-registry" });
    await setup(ctx);
    original.options.endpoint = "https://changed.test";
    try {
      await ctx.registered.transit[0].searchStopsByName?.("X", 1);
      expect(search.mock.calls[0][0]).toMatchObject({
        options: { endpoint: "https://hafas.test/mgate", auth: { type: "fixture" } },
        timezone: entry.timezone,
        coverage: entry.coverage,
      });
    } finally {
      search.mockRestore();
      registry.stopRefresh();
    }
  });
  it("retains old entry endpoint and receipts after a registry replacement", async () => {
    const original = structuredClone(entry);
    vi.mocked(fetchRegistryEntries).mockResolvedValue([original]);
    const http = fakeHttpClient(() => ({ data: { stops: [stop] } }));
    const ctx = createMockIntegrationContext({ id: "transit-dynamic-registry", http });
    ctx.upstreamRuntime = shared();
    await setup(ctx);
    original.options.endpoint = "https://changed.test";
    original.attribution = { name: "Changed" };
    const replacement = new RegistryManager(async () => [original]);
    await replacement.initialize();
    registry.replaceWith(replacement);
    try {
      const result = await ctx.registered.transit[0].searchStopsByName?.("Public", 1);
      expect(result?.attributions[0].name).toBe("Peatus");
      expect(http.calls[0].url).toBe(
        "https://api.peatus.ee/routing/v1/routers/estonia/index/graphql",
      );
    } finally {
      registry.stopRefresh();
    }
  });
  it("rejects shutdown while the final publication policy check is pending", async () => {
    vi.mocked(fetchRegistryEntries).mockResolvedValue([structuredClone(entry)]);
    const http = fakeHttpClient(() => ({ data: { stops: [stop] } }));
    const ctx = createMockIntegrationContext({ id: "transit-dynamic-registry", http });
    ctx.upstreamRuntime = shared();
    let checks = 0,
      finish!: () => void;
    const shutdown: Array<() => Promise<void>> = [];
    ctx.onShutdown = (fn) => shutdown.push(fn);
    ctx.getDisallowedSourceIds = async () => {
      if (++checks === 5)
        await new Promise<void>((r) => {
          finish = r;
        });
      return new Set();
    };
    await setup(ctx);
    const pending = ctx.registered.transit[0].searchStopsByName!("Public", 1);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await shutdown[0]();
    await expect(pending).rejects.toThrow("OTP request cancelled");
    finish();
    registry.stopRefresh();
  });
});
