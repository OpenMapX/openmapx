import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_SHAPES, type ProviderDomain } from "../contracts/provider-shapes";
import type { LoadedIntegration } from "../loader";
import {
  collectOrderedProviders,
  effectiveProviderOrder,
  ORCHESTRATOR_BY_DOMAIN,
  readProviderOrder,
  UNLISTED_BY_DOMAIN,
} from "../provider-order";
import { createMockIntegrationContext } from "../testing/index.js";

interface Provider {
  id: string;
  priority?: number;
}

const pa: Provider = { id: "pa" };
const pb1: Provider = { id: "pb1" };
const pb2: Provider = { id: "pb2" };
const pc: Provider = { id: "pc" };

type Registered = Array<[string, Provider[]]>;

/** A context whose every domain has `integrations` registered and `order` set. */
function fakeCtx(state: { order: readonly string[]; integrations: Registered }) {
  return Object.assign(createMockIntegrationContext(), {
    getProviderOrder: () => state.order,
    getIntegrationsByDomain: (domain: string) =>
      state.integrations.map(
        ([id, providers]) =>
          ({ id, providers: new Map([[domain, providers]]) }) as unknown as LoadedIntegration,
      ),
  });
}

const reg = fakeCtx({
  order: ["b", "ghost", "a"],
  integrations: [
    ["a", [pa]],
    ["b", [pb1, pb2]],
    ["c", [pc]],
  ],
});

describe("collectOrderedProviders", () => {
  it("puts listed integrations first, in list order, then the rest", () => {
    expect(collectOrderedProviders(reg, "weather").map((e) => e.provider)).toEqual([
      pb1,
      pb2,
      pa,
      pc,
    ]);
  });

  it("skips a listed integration that is not loaded", () => {
    const entries = collectOrderedProviders(reg, "weather");
    expect(entries.map((e) => e.integrationId)).toEqual(["b", "b", "a", "c"]);
    expect(entries.some((e) => e.integrationId === "ghost")).toBe(false);
  });

  it("orders the unlisted tail by the domain's fallback", () => {
    const late: Provider = { id: "late", priority: 9 };
    const early: Provider = { id: "early", priority: 1 };
    const none: Provider = { id: "none" };
    const ctx = fakeCtx({
      order: ["b"],
      integrations: [
        ["none", [none]],
        ["late", [late]],
        ["b", [pb1]],
        ["early", [early]],
      ],
    });
    expect(collectOrderedProviders<Provider>(ctx, "routing").map((e) => e.provider)).toEqual([
      pb1,
      early,
      late,
      none,
    ]);
    expect(collectOrderedProviders<Provider>(ctx, "fuel-stations").map((e) => e.provider)).toEqual([
      pb1,
      none,
      late,
      early,
    ]);
  });

  it("sorts unlisted street-level photo sources last", () => {
    const mapillary = { id: "mapillary" };
    const commons = { id: "wikimedia" };
    const ctx = fakeCtx({
      order: [],
      integrations: [
        ["photos-mapillary", [mapillary]],
        ["photos-wikimedia", [commons]],
      ],
    });
    expect(collectOrderedProviders(ctx, "photos").map((e) => e.provider)).toEqual([
      commons,
      mapillary,
    ]);
  });

  it("orders unlisted transit providers by role, then priority, then id", () => {
    const regional = { id: "r", role: "regional", priority: 1 };
    const baselineLate = { id: "z", role: "baseline", priority: 5 };
    const baselineEarly = { id: "y", role: "baseline", priority: 5 };
    const ctx = fakeCtx({
      order: [],
      integrations: [
        ["one", [regional, baselineLate]],
        ["two", [baselineEarly]],
      ],
    });
    expect(collectOrderedProviders(ctx, "transit").map((e) => e.provider)).toEqual([
      baselineEarly,
      baselineLate,
      regional,
    ]);
  });

  it("orders unlisted air-quality providers by priority, then id, then integration", () => {
    const second = { id: "b", priority: 1 };
    const first = { id: "a", priority: 1 };
    const last = { id: "0", priority: 2 };
    const ctx = fakeCtx({
      order: [],
      integrations: [
        ["x", [last, second]],
        ["y", [first]],
      ],
    });
    expect(collectOrderedProviders(ctx, "air-quality").map((e) => e.provider)).toEqual([
      first,
      second,
      last,
    ]);
  });

  it("can exclude unlisted integrations", () => {
    expect(
      collectOrderedProviders(reg, "geocoding", { unlisted: "exclude" }).map(
        (e) => e.integrationId,
      ),
    ).toEqual(["b", "b", "a"]);
  });

  it("returns the registered objects themselves", () => {
    const [first] = collectOrderedProviders(reg, "weather");
    expect(first?.provider).toBe(pb1);
  });

  it("changes the fingerprint when a provider joins", () => {
    const state = { order: ["b"], integrations: [["b", [pb1]]] as Registered };
    const ctx = fakeCtx(state);
    const before = ctx.getProviderOrderFingerprint("weather");
    expect(before).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.getProviderOrderFingerprint("weather")).toBe(before);
    state.integrations = [...state.integrations, ["c", [pc]]];
    expect(ctx.getProviderOrderFingerprint("weather")).not.toBe(before);
  });

  it("leaves an integration out of the fingerprint of a domain that excludes it", () => {
    const state = { order: ["b"], integrations: [["b", [pb1]]] as Registered };
    const ctx = fakeCtx(state);
    const before = ctx.getProviderOrderFingerprint("geocoding");
    state.integrations = [...state.integrations, ["c", [pc]]];
    expect(ctx.getProviderOrderFingerprint("geocoding")).toBe(before);
  });

  it("changes the fingerprint when only an unlisted provider's priority reorders the domain", () => {
    const state = {
      order: [] as string[],
      integrations: [
        ["wa", [{ id: "wa", priority: 1 }]],
        ["wb", [{ id: "wb", priority: 2 }]],
      ] as Registered,
    };
    const ctx = fakeCtx(state);
    const before = ctx.getProviderOrderFingerprint("weather");
    state.integrations = [
      ["wa", [{ id: "wa", priority: 9 }]],
      ["wb", [{ id: "wb", priority: 2 }]],
    ];
    expect(collectOrderedProviders<Provider>(ctx, "weather").map((e) => e.integrationId)).toEqual([
      "wb",
      "wa",
    ]);
    expect(ctx.getProviderOrderFingerprint("weather")).not.toBe(before);
  });

  it("changes the fingerprint when one integration's providers swap places", () => {
    const w1 = { id: "w1", priority: 1 };
    const w2 = { id: "w2", priority: 2 };
    const state = { order: [] as string[], integrations: [["w", [w1, w2]]] as Registered };
    const ctx = fakeCtx(state);
    const before = ctx.getProviderOrderFingerprint("weather");
    w1.priority = 3;
    expect(ctx.getProviderOrderFingerprint("weather")).not.toBe(before);
  });

  it("computes the same fingerprint as the host for the same served providers", () => {
    const ctx = fakeCtx({
      order: [],
      integrations: [["asker", [{ id: "asker-weather", priority: 1 }]]],
    });
    expect(ctx.getProviderOrderFingerprint("weather")).toBe(
      createHash("sha256")
        .update(JSON.stringify([["asker", "asker-weather"]]))
        .digest("hex")
        .slice(0, 16),
    );
  });

  it("keeps the fingerprint when the served order does not change", () => {
    const state = {
      order: ["wa"] as string[],
      integrations: [
        ["wb", [{ id: "wb", priority: 2 }]],
        ["wa", [{ id: "wa", priority: 5 }]],
        ["wc", [{ id: "wc", priority: 3 }]],
      ] as Registered,
    };
    const ctx = fakeCtx(state);
    const before = ctx.getProviderOrderFingerprint("weather");
    state.order = ["wa", "ghost", "wa"];
    state.integrations = [
      ["wb", [{ id: "wb", priority: 1 }]],
      ["wa", [{ id: "wa", priority: 99 }]],
      ["wc", [{ id: "wc", priority: 7 }]],
    ];
    expect(ctx.getProviderOrderFingerprint("weather")).toBe(before);
  });
});

describe("effectiveProviderOrder", () => {
  it("lists each integration with providers once, listed ones first", () => {
    const integrations = [
      { id: "a", providers: new Map([["weather", [pa]]]) },
      { id: "empty", providers: new Map<string, unknown[]>() },
      { id: "b", providers: new Map([["weather", [pb1, pb2]]]) },
    ];
    expect(effectiveProviderOrder(["b", "ghost"], integrations, "weather")).toEqual([
      { integrationId: "b", listed: true },
      { integrationId: "a", listed: false },
    ]);
  });

  it("is the served order of integrations in a priority-ordered domain", () => {
    const ctx = fakeCtx({
      order: ["mid"],
      integrations: [
        ["slow", [{ id: "slow", priority: 9 }]],
        ["mid", [{ id: "mid", priority: 5 }]],
        ["fast", [{ id: "fast", priority: 1 }]],
      ],
    });
    const served = collectOrderedProviders(ctx, "weather").map((e) => e.integrationId);
    expect(served).toEqual(["mid", "fast", "slow"]);
    expect(
      effectiveProviderOrder(
        ctx.getProviderOrder("weather"),
        ctx.getIntegrationsByDomain("weather"),
        "weather",
      ).map((e) => e.integrationId),
    ).toEqual(served);
  });
});

describe("readProviderOrder", () => {
  it("drops entries that are not strings and later repeats", () => {
    expect(readProviderOrder(["b", 1, null, "a", "b", { id: "c" }, "c"])).toEqual(["b", "a", "c"]);
    expect(readProviderOrder("a")).toEqual([]);
  });

  it("cuts an order longer than 64 entries to 64 and reports it once", () => {
    const long = Array.from({ length: 70 }, (_, index) => `p${index}`);
    const cut = vi.fn();
    expect(readProviderOrder(long, cut)).toEqual(long.slice(0, 64));
    expect(cut).toHaveBeenCalledTimes(1);
    expect(cut).toHaveBeenCalledWith(70);
    expect(readProviderOrder(long.slice(0, 64), cut)).toHaveLength(64);
    expect(cut).toHaveBeenCalledTimes(1);
  });

  it("normalises an order given to the mock context the same way", () => {
    expect(
      createMockIntegrationContext({
        providerOrder: { weather: ["b", "b", "a"] },
      }).getProviderOrder("weather"),
    ).toEqual(["b", "a"]);
  });
});

describe("domain tables", () => {
  it("name an orchestrator and an unlisted rule for every provider domain", () => {
    const domains = Object.keys(PROVIDER_SHAPES).sort();
    expect(Object.keys(ORCHESTRATOR_BY_DOMAIN).sort()).toEqual(domains);
    expect(Object.keys(UNLISTED_BY_DOMAIN).sort()).toEqual(domains);
    const withoutOrchestrator = (Object.keys(ORCHESTRATOR_BY_DOMAIN) as ProviderDomain[])
      .filter((domain) => ORCHESTRATOR_BY_DOMAIN[domain] === null)
      .sort();
    expect(withoutOrchestrator).toEqual([
      "gtfs-catalog",
      "hazards",
      "knowledge",
      "street-level-imagery",
    ]);
    expect(
      (Object.keys(UNLISTED_BY_DOMAIN) as ProviderDomain[]).filter(
        (domain) => UNLISTED_BY_DOMAIN[domain] === "exclude",
      ),
    ).toEqual(["geocoding"]);
  });

  it("returns no order from the mock context unless one is given", () => {
    expect(createMockIntegrationContext().getProviderOrder("weather")).toEqual([]);
    expect(
      createMockIntegrationContext({ providerOrder: { weather: ["b"] } }).getProviderOrder(
        "weather",
      ),
    ).toEqual(["b"]);
  });
});
