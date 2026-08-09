import type { RideProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { createRideOrchestrator, redactUrlsInReason } from "./orchestrator.js";

const freshness = {
  fetchedAt: "2026-08-09T00:00:00.000Z",
  hasRealtimeData: false,
  isStale: false,
};

function makeProvider(over: Partial<RideProvider> & { id: string }): RideProvider {
  return {
    meta: { name: over.id, homepage: `https://${over.id}.example/`, sourceId: over.id },
    capabilities: { deepLink: true, quote: false, booking: false, tracking: false },
    permitsComparison: false,
    attribution: [{ sourceId: over.id, name: over.id }],
    getAvailability: async () => ({
      data: { available: true, coverageChecked: false, products: [] },
      attributions: [],
      freshness,
    }),
    createHandoff: () => ({ webUrl: `https://${over.id}.example/ride`, carriesCoordinates: false }),
    ...over,
  } as RideProvider;
}

function ctxWith(providers: RideProvider[], config: Record<string, unknown> = {}) {
  const ctx = createMockIntegrationContext({ id: "ride-hailing", config });
  ctx.getIntegrationsByDomain = ((domain: string) =>
    domain === "ride-hailing"
      ? [{ id: "fakes", providers: new Map([["ride-hailing", providers]]) }]
      : []) as typeof ctx.getIntegrationsByDomain;
  return ctx;
}

const request = { pickup: [13.405, 52.52] as [number, number] };

describe("listProviders", () => {
  it("drops providers whose declared coverage excludes the pickup", async () => {
    const inBox = makeProvider({ id: "in", coverage: { bbox: [13, 52, 14, 53] } });
    const outBox = makeProvider({ id: "out", coverage: { bbox: [0, 0, 1, 1] } });
    const o = createRideOrchestrator(ctxWith([inBox, outBox]));
    const { providers } = await o.listProviders(request);
    expect(providers.map((p) => p.id)).toEqual(["in"]);
  });

  it("drops providers that report themselves unavailable", async () => {
    const away = makeProvider({
      id: "away",
      getAvailability: async () => ({
        data: {
          available: false,
          coverageChecked: true,
          reason: "outside-service-area" as const,
          products: [],
        },
        attributions: [],
        freshness,
      }),
    });
    const o = createRideOrchestrator(ctxWith([makeProvider({ id: "here" }), away]));
    const { providers } = await o.listProviders(request);
    expect(providers.map((p) => p.id)).toEqual(["here"]);
  });

  it("keeps a provider whose availability call throws out of the list", async () => {
    const broken = makeProvider({
      id: "broken",
      getAvailability: async () => {
        throw new Error("upstream down");
      },
    });
    const o = createRideOrchestrator(ctxWith([makeProvider({ id: "ok" }), broken]));
    const { providers } = await o.listProviders(request);
    expect(providers.map((p) => p.id)).toEqual(["ok"]);
  });

  it("skips providers whose source the operator policy disallows", async () => {
    const ctx = ctxWith([makeProvider({ id: "allowed" }), makeProvider({ id: "banned" })]);
    ctx.getDisallowedSourceIds = async () => new Set(["banned"]);
    const o = createRideOrchestrator(ctx);
    const { providers } = await o.listProviders(request);
    expect(providers.map((p) => p.id)).toEqual(["allowed"]);
  });

  it("reports comparison as disallowed by default", async () => {
    const o = createRideOrchestrator(ctxWith([makeProvider({ id: "a" })]));
    const { comparison } = await o.listProviders(request);
    expect(comparison.allowed).toBe(false);
  });

  it("lists only comparison-permitting providers as comparable when unlocked", async () => {
    const open = makeProvider({ id: "open", permitsComparison: true });
    const closed = makeProvider({ id: "closed", permitsComparison: false });
    const o = createRideOrchestrator(ctxWith([open, closed], { allowQuoteComparison: true }));
    const { comparison } = await o.listProviders(request);
    expect(comparison.allowed).toBe(true);
    expect(comparison.comparableProviderIds).toEqual(["open"]);
  });
});

describe("redactUrlsInReason", () => {
  it("strips the query string that carries rider coordinates", () => {
    const raw =
      "Request failed: HTTP 500 for https://feed.example/wait_time?pickup_lat=52.52&pickup_lon=13.405";
    const out = redactUrlsInReason(raw);
    expect(out).not.toContain("52.52");
    expect(out).not.toContain("13.405");
    expect(out).toContain("https://feed.example/wait_time");
  });

  it("strips a query-parameter API key", () => {
    const out = redactUrlsInReason(
      "Request failed: HTTP 403 for https://x.example/gofs?api_key=s3cret",
    );
    expect(out).not.toContain("s3cret");
  });

  it("leaves a message with no URL untouched", () => {
    expect(redactUrlsInReason("ECONNREFUSED")).toBe("ECONNREFUSED");
  });
});

describe("logging", () => {
  it("never writes rider coordinates into the log on a provider failure", async () => {
    const warn = vi.fn();
    const broken = makeProvider({
      id: "broken",
      getAvailability: async () => {
        throw new Error(
          "Request failed: HTTP 500 for https://feed.example/wait_time?pickup_lat=52.52&pickup_lon=13.405",
        );
      },
    });
    const ctx = ctxWith([broken]);
    ctx.log.warn = warn;
    await createRideOrchestrator(ctx).listProviders(request);
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("52.52");
      expect(JSON.stringify(call)).not.toContain("13.405");
    }
    expect(warn).toHaveBeenCalled();
  });
});

describe("getQuotes", () => {
  const quoting = (id: string, permitsComparison: boolean) =>
    makeProvider({
      id,
      permitsComparison,
      capabilities: { deepLink: true, quote: true, booking: false, tracking: false },
      quoteTtlSeconds: 45,
      getQuotes: async () => ({
        data: [
          {
            productId: "std",
            product: { id: "std", name: "Standard" },
            pickupEtaSeconds: 180,
            expiresAt: "1970-01-01T00:00:00.000Z",
          },
        ],
        attributions: [],
        freshness,
      }),
    });

  it("rejects more than one provider while comparison is locked", async () => {
    const o = createRideOrchestrator(ctxWith([quoting("a", true), quoting("b", true)]));
    await expect(o.getQuotes(request, ["a", "b"])).rejects.toThrow(/comparison/i);
  });

  it("drops providers that forbid comparison even when comparison is unlocked", async () => {
    const o = createRideOrchestrator(
      ctxWith([quoting("open", true), quoting("closed", false)], { allowQuoteComparison: true }),
    );
    const results = await o.getQuotes(request, ["open", "closed"]);
    expect(results.map((r) => r.providerId)).toEqual(["open"]);
  });

  it("stamps expiresAt from the provider TTL, overriding what the provider returned", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const o = createRideOrchestrator(ctxWith([quoting("a", true)]));
    const [result] = await o.getQuotes(request, ["a"]);
    expect(result.quotes[0].expiresAt).toBe("2026-08-09T12:00:45.000Z");
    vi.useRealTimers();
  });

  it("returns an empty quote list for a provider without the quote capability", async () => {
    const o = createRideOrchestrator(ctxWith([makeProvider({ id: "linkonly" })]));
    const [result] = await o.getQuotes(request, ["linkonly"]);
    expect(result.quotes).toEqual([]);
  });
});
