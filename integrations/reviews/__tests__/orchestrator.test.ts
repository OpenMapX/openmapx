import type { LoadedIntegration } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import {
  cacheKeyForSubject,
  fetchAggregate,
  fetchReviews,
  getReviewProviders,
} from "../orchestrator.js";
import type { Review, ReviewProvider, ReviewSubject } from "../types.js";

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

const SUBJECT: ReviewSubject = { lat: 50.77, lng: 6.08, name: "Frittenwerk" };

function review(id: string): Review {
  return {
    id,
    subject: SUBJECT,
    author: { kid: "k" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("fetchReviews source tagging", () => {
  it("stamps each review with the producing provider's id", async () => {
    const p = reviewProvider("mangrove");
    (p.getReviews as ReturnType<typeof vi.fn>).mockResolvedValue([review("r1")]);
    const [r] = await fetchReviews(SUBJECT, [p]);
    expect(r.source).toBe("mangrove");
  });

  it("preserves a source the provider already set (does not overwrite)", async () => {
    const p = reviewProvider("mangrove");
    (p.getReviews as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...review("r1"), source: "preset" },
    ]);
    const [r] = await fetchReviews(SUBJECT, [p]);
    expect(r.source).toBe("preset");
  });
});

describe("fetchAggregate source tagging", () => {
  it("stamps the aggregate with the producing provider's id", async () => {
    const p = reviewProvider("mangrove");
    (p.getAggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 5,
      opinionCount: 5,
      positiveCount: 4,
      confirmedCount: 0,
      quality: 80,
      stars: 4,
    });
    const agg = await fetchAggregate(SUBJECT, [p]);
    expect(agg.source).toBe("mangrove");
  });

  it("leaves the zero fallback aggregate untagged when every provider fails", async () => {
    const p = reviewProvider("mangrove");
    (p.getAggregate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));
    const agg = await fetchAggregate(SUBJECT, [p]);
    expect(agg.source).toBeUndefined();
    expect(agg.count).toBe(0);
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
