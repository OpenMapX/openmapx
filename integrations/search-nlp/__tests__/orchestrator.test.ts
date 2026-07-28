import type {
  NlpProvider,
  NlpProviderId,
  ParseContext,
  SearchIntent,
} from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { createChain } from "../orchestrator";

const ctx: ParseContext = {
  mapCenter: [2.3522, 48.8566],
  mapBbox: { south: 48.85, west: 2.33, north: 48.87, east: 2.37 },
};

const okIntent: SearchIntent = {
  filter: {
    selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }],
  },
  spatial_constraint: { type: "current_view" },
  time_constraint: null,
  sort_by: "relevance",
  unmapped_attributes: [],
  confidence: 0.8,
  explanation: "Searching for cafes",
};

function provider(
  id: NlpProviderId,
  impl: (query: string, ctx: ParseContext) => Promise<SearchIntent>,
  net = false,
): NlpProvider {
  return {
    id,
    label: id,
    cacheKey: id,
    isAi: id !== "keyword",
    requiresNetwork: net,
    cloudProcessors: [],
    parseQuery: vi.fn(impl),
  };
}

describe("createChain", () => {
  it("exposes the provided providers list", () => {
    const p1 = provider("local", () => Promise.resolve(okIntent));
    const chain = createChain([p1]);
    expect(chain.providers).toEqual([p1]);
  });

  it("returns the first provider's result on success", async () => {
    const p1 = provider("local", () => Promise.resolve(okIntent));
    const p2 = provider("keyword", () => Promise.resolve({ ...okIntent, confidence: 0.5 }));
    const chain = createChain([p1, p2]);

    const result = await chain.parse("coffee", ctx);
    expect(result.provider).toEqual({ id: "local", label: "local", cloud: false });
    expect(result.intent).toEqual(okIntent);
    expect(p2.parseQuery).not.toHaveBeenCalled();
  });

  it("falls through to the next provider when first fails", async () => {
    const p1 = provider("local", () => Promise.reject(new Error("local offline")));
    const p2 = provider("keyword", () => Promise.resolve(okIntent));
    const chain = createChain([p1, p2]);

    const result = await chain.parse("coffee", ctx);
    expect(result.provider.id).toBe("keyword");
    expect(result.intent).toEqual(okIntent);
    expect(p1.parseQuery).toHaveBeenCalledOnce();
    expect(p2.parseQuery).toHaveBeenCalledOnce();
  });

  it("throws when all providers fail, message includes all provider errors", async () => {
    const p1 = provider("local", () => Promise.reject(new Error("network error")));
    const p2 = provider("claude", () => Promise.reject(new Error("quota exceeded")), true);
    const chain = createChain([p1, p2]);

    await expect(chain.parse("coffee", ctx)).rejects.toThrow("All NLP providers failed:");
    await expect(chain.parse("coffee", ctx)).rejects.toThrow("local: network error");
    await expect(chain.parse("coffee", ctx)).rejects.toThrow("claude: quota exceeded");
  });

  it("passes query and ctx through to the provider", async () => {
    const parseQuery = vi.fn(() => Promise.resolve(okIntent));
    const p1 = provider("keyword", parseQuery);
    const chain = createChain([p1]);

    await chain.parse("vegan restaurant", ctx);
    expect(parseQuery).toHaveBeenCalledWith("vegan restaurant", ctx);
  });

  it("reports an individual failure even when a later provider succeeds", async () => {
    const failed = provider("cloud", () => Promise.reject(new Error("unavailable")), true);
    const fallback = provider("keyword", () => Promise.resolve(okIntent));
    const onProviderFailure = vi.fn();
    const chain = createChain([failed, fallback], { onProviderFailure });

    await expect(chain.parse("coffee", ctx)).resolves.toMatchObject({
      provider: { id: "keyword" },
    });
    expect(onProviderFailure).toHaveBeenCalledWith(failed, expect.any(Error));
  });
});
