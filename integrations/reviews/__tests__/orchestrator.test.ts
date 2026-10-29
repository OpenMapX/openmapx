import type { LoadedIntegration } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import mangroveManifest from "../../reviews-mangrove/manifest.json";
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
  it("preserves a retryable provider failure ahead of a later permanent failure", async () => {
    const first = reviewProvider("first");
    const second = reviewProvider("second");
    const throttled = Object.assign(new Error("busy"), { status: 429, retryAfterMs: 8000 });
    (first.getAggregate as ReturnType<typeof vi.fn>).mockRejectedValue(throttled);
    (second.getAggregate as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("gone"), { status: 404 }),
    );
    await expect(fetchAggregate(SUBJECT, [first, second], { strict: true })).rejects.toBe(
      throttled,
    );
  });

  it("does not turn a falsy provider rejection into a confirmed zero aggregate", async () => {
    const provider = reviewProvider("falsy");
    (provider.getAggregate as ReturnType<typeof vi.fn>).mockRejectedValue(undefined);
    await expect(fetchAggregate(SUBJECT, [provider], { strict: true })).rejects.toBeUndefined();
  });
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

function capturedIntegration(provider: ReviewProvider): LoadedIntegration {
  const integration = loadedIntegration("reviews-mangrove", ["reviews"], true, [provider]);
  integration.manifest.dataSources = structuredClone(mangroveManifest.dataSources) as NonNullable<
    LoadedIntegration["manifest"]["dataSources"]
  >;
  return integration;
}

function sources(integration: LoadedIntegration) {
  const sources = integration.manifest.dataSources;
  if (!sources?.length) throw new Error("Missing review source fixture");
  return sources;
}

describe("registered review acquisition receipts", () => {
  it("captures each read before awaiting, even when metadata changes and the integration is disabled", async () => {
    const pending = Promise.withResolvers<Review[]>();
    const original = { ...review("one"), metadata: { license: "CC-BY-SA-4.0" as const } };
    const provider = reviewProvider("mangrove");
    provider.getReviews = () => pending.promise;
    const integration = capturedIntegration(provider);
    const [wrapped] = getReviewProviders([integration]);
    const read = wrapped.getReviews(SUBJECT);
    sources(integration)[0].name = "Changed supplier";
    sources(integration)[0].url = "https://changed.test/";
    integration.enabled = false;
    pending.resolve([original]);
    const [result] = await read;
    expect(result.contributors).toMatchObject([
      { sourceId: "mangrove", name: "Mangrove.reviews", url: "https://mangrove.reviews/" },
    ]);
    expect(result).not.toBe(original);
    expect(original).not.toHaveProperty("contributors");
    expect(result.metadata?.license).toBe("CC-BY-SA-4.0");
    expect((await wrapped.getReviews(SUBJECT))[0].contributors?.[0]?.name).toBe("Changed supplier");
    sources(integration)[0].name = "Changed again";
    expect(result.contributors?.[0]?.name).toBe("Mangrove.reviews");
  });

  it("matches each returned source exactly and preserves supplied empty, invalid and historical receipts", async () => {
    const historical = [{ sourceId: "old", name: "Historical credit", url: "https://old.test/" }];
    const provider = reviewProvider("mangrove");
    provider.getReviews = async () => [
      review("default"),
      { ...review("explicit"), source: "other" },
      { ...review("unknown"), source: "mangrove-unknown" },
      { ...review("empty"), contributors: [] },
      { ...review("invalid"), contributors: [{ sourceId: "bad" }] as never },
      { ...review("historical"), contributors: historical },
    ];
    const integration = capturedIntegration(provider);
    sources(integration).push({
      ...sources(integration)[0],
      sourceId: "other",
      name: "Other supplier",
    });
    const results = await getReviewProviders([integration])[0].getReviews(SUBJECT);
    expect(results.map((r) => r.contributors?.map((a) => a.name))).toEqual([
      ["Mangrove.reviews"],
      ["Other supplier"],
      [],
      [],
      [],
      ["Historical credit"],
    ]);
    historical[0].name = "Mutated cache";
    expect(results[5].contributors?.[0]?.name).toBe("Historical credit");
  });

  it("keeps only the duplicate winner and successful aggregate supplier", async () => {
    const first = reviewProvider("mangrove");
    const second = reviewProvider("second");
    first.getReviews = async () => [review("duplicate")];
    second.getReviews = async () => [review("duplicate")];
    first.getAggregate = async () => {
      throw new Error("unavailable");
    };
    const retainedAggregate = {
      count: 3,
      opinionCount: 0,
      positiveCount: 3,
      confirmedCount: 0,
      quality: 80,
      stars: 4,
    };
    second.getAggregate = async () => retainedAggregate;
    const a = capturedIntegration(first);
    const b = capturedIntegration(second);
    sources(b)[0].sourceId = "second";
    sources(b)[0].name = "Successful supplier";
    const providers = getReviewProviders([a, b]);
    const reviews = await fetchReviews(SUBJECT, providers);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].contributors?.map((a) => a.name)).toEqual(["Mangrove.reviews"]);
    const aggregate = await fetchAggregate(SUBJECT, providers);
    expect(aggregate.contributors?.map((a) => a.name)).toEqual(["Successful supplier"]);
    expect(retainedAggregate).not.toHaveProperty("contributors");
    second.getAggregate = async () => {
      throw new Error("also unavailable");
    };
    expect((await fetchAggregate(SUBJECT, providers)).contributors ?? []).toEqual([]);
  });

  it("captures aggregates before awaiting and keeps method receiver, options and optional methods", async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<ReviewProvider["getAggregate"]>>>();
    const controller = new AbortController();
    const options = { signal: controller.signal, strict: true };
    const provider: ReviewProvider = {
      id: "mangrove",
      name: "Provider",
      async getReviews() {
        return [{ ...review(this.id), source: this.id }];
      },
      getAggregate(_subject, passed) {
        expect(this).toBe(provider);
        expect(passed).toBe(options);
        return pending.promise;
      },
      async submit(jwt) {
        return { id: `${this.id}:${jwt}` };
      },
      async uploadImage(_file, filename) {
        return { src: `https://images.test/${this.id}/${filename}` };
      },
    };
    const integration = capturedIntegration(provider);
    const [wrapped] = getReviewProviders([integration]);
    const read = wrapped.getAggregate(SUBJECT, options);
    integration.manifest.dataSources = [];
    pending.resolve({
      count: 1,
      opinionCount: 0,
      positiveCount: 0,
      confirmedCount: 0,
      quality: 0,
      stars: 0,
    });
    expect((await read).contributors?.[0]?.name).toBe("Mangrove.reviews");
    expect((await wrapped.getReviews(SUBJECT))[0].id).toBe("mangrove");
    expect(await wrapped.submit?.("jwt")).toEqual({ id: "mangrove:jwt" });
    expect(await wrapped.uploadImage?.(new Blob(), "one.jpg")).toEqual({
      src: "https://images.test/mangrove/one.jpg",
    });
    expect(
      getReviewProviders([capturedIntegration(reviewProvider("mangrove"))])[0],
    ).not.toHaveProperty("submit");
  });
});
