import { describe, expect, it } from "vitest";
import { PROVIDER_SHAPES, type ProviderDomain } from "../contracts/provider-shapes";
import type { LoadedIntegration } from "../loader";
import {
  collectOrderedProviders,
  effectiveProviderOrder,
  ORCHESTRATOR_BY_DOMAIN,
  type OrderedProvider,
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

  it("orders the unlisted tail with the fallback comparator", () => {
    const late: Provider = { id: "late", priority: 9 };
    const early: Provider = { id: "early", priority: 1 };
    const ctx = fakeCtx({
      order: ["b"],
      integrations: [
        ["late", [late]],
        ["b", [pb1]],
        ["early", [early]],
      ],
    });
    const byPriority = (x: OrderedProvider<Provider>, y: OrderedProvider<Provider>) =>
      (x.provider.priority ?? 0) - (y.provider.priority ?? 0);
    expect(
      collectOrderedProviders<Provider>(ctx, "routing", { fallback: byPriority }).map(
        (e) => e.provider,
      ),
    ).toEqual([pb1, early, late]);
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
