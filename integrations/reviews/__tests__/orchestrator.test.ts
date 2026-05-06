import type { LoadedIntegration } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { cacheKeyForSubject, getReviewProviders } from "../orchestrator.js";
import type { ReviewProvider } from "../types.js";

function reviewProvider(id: string): ReviewProvider {
  return {
    id,
    name: id,
    getReviews: vi.fn<ReviewProvider["getReviews"]>().mockResolvedValue([]),
    getAggregate: vi.fn<ReviewProvider["getAggregate"]>().mockResolvedValue({
      count: 0,
      opinionCount: 0,
      positiveCount: 0,
      confirmedCount: 0,
      quality: 0,
      stars: 0,
    }),
  };
}

function loadedIntegration(
  id: string,
  domains: string[],
  enabled: boolean,
  providers: ReviewProvider[],
): LoadedIntegration {
  return {
    id,
    manifest: { id, domains },
    config: {},
    directory: `/integrations/${id}`,
    isBuiltIn: true,
    enabled,
    providers: new Map([["reviews", providers]]),
    strings: {},
    shutdownHandlers: [],
  };
}

describe("getReviewProviders", () => {
  it("ignores disabled integrations and integrations outside the reviews domain", () => {
    const enabledReview = reviewProvider("enabled-review");
    const disabledReview = reviewProvider("disabled-review");
    const wrongDomain = reviewProvider("wrong-domain");

    const providers = getReviewProviders([
      loadedIntegration("reviews-enabled", ["reviews"], true, [enabledReview]),
      loadedIntegration("reviews-disabled", ["reviews"], false, [disabledReview]),
      loadedIntegration("photos-only", ["photos"], true, [wrongDomain]),
    ]);

    expect(providers.map((p) => p.id)).toEqual(["enabled-review"]);
  });

  it("preserves registration order for primary-provider selection", () => {
    const first = reviewProvider("first");
    const second = reviewProvider("second");
    const third = reviewProvider("third");

    const providers = getReviewProviders([
      loadedIntegration("a", ["reviews"], true, [first, second]),
      loadedIntegration("b", ["reviews"], true, [third]),
    ]);

    expect(providers.map((p) => p.id)).toEqual(["first", "second", "third"]);
  });
});

describe("cacheKeyForSubject", () => {
  it("separates otherwise-identical subjects by OSM identity", () => {
    const base = { lat: 50.7750682, lng: 6.0877905, name: "Frittenwerk" };

    expect(cacheKeyForSubject({ ...base, osmId: "node/4506022549" })).not.toBe(
      cacheKeyForSubject({ ...base, osmId: "node/1" }),
    );
  });

  it("normalizes OSM refs in cache keys", () => {
    const base = { lat: 50.7750682, lng: 6.0877905, name: "Frittenwerk" };

    expect(cacheKeyForSubject({ ...base, osmId: "osm:Node/4506022549/7" })).toBe(
      cacheKeyForSubject({ ...base, osmId: "node/4506022549" }),
    );
  });
});
