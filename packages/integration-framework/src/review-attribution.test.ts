import type { ReviewAggregate, ReviewProvider, ReviewSubject } from "@openmapx/core";
import { expect, it } from "vitest";
import { captureReviewProviderContributors } from "./review-attribution";
import { createMockIntegrationContext } from "./testing";

const subject: ReviewSubject = { lat: 51, lng: 6, name: "Cafe" };
const aggregate: ReviewAggregate = {
  count: 1,
  opinionCount: 0,
  positiveCount: 1,
  confirmedCount: 0,
  quality: 80,
  stars: 4,
};

it("keeps explicit aggregate receipts authoritative and copies them before a caller caches them", async () => {
  const ctx = createMockIntegrationContext();
  ctx.manifest.dataSources = [
    {
      sourceId: "reviews",
      name: "Current service",
      url: "https://current.test/",
      providerCountry: "DE",
      providerPrivacyUrl: "https://current.test/privacy",
      licensing: {
        version: 1,
        bindings: [{ scope: "data", subject: "Reviews", license: { kind: "unknown" } }],
      },
    },
  ];
  let result = {
    ...aggregate,
    contributors: [
      {
        sourceId: "historical",
        name: "Original wording",
        publisher: { name: "Original publisher" },
      },
    ],
  };
  const provider: ReviewProvider = {
    id: "reviews",
    name: "Reviews",
    getReviews: async () => [],
    getAggregate: async () => result,
  };
  const wrapped = captureReviewProviderContributors(ctx, provider);
  const captured = await wrapped.getAggregate(subject);
  expect(captured).not.toBe(result);
  result.contributors[0].publisher.name = "Changed publisher";
  expect(captured.contributors?.[0]?.publisher?.name).toBe("Original publisher");
  for (const contributors of [[], null, [{ sourceId: "invalid" }]]) {
    result = { ...aggregate, contributors } as never;
    expect((await wrapped.getAggregate(subject)).contributors).toEqual([]);
  }
});

it("does not use a declared catalogue wholesale when provider and explicit source identities are unknown", async () => {
  const ctx = createMockIntegrationContext();
  ctx.manifest.dataSources = [
    {
      sourceId: "declared",
      name: "Unrelated supplier",
      url: "https://declared.test/",
      providerCountry: "DE",
      providerPrivacyUrl: "https://declared.test/privacy",
      licensing: {
        version: 1,
        bindings: [{ scope: "data", subject: "Reviews", license: { kind: "unknown" } }],
      },
    },
  ];
  const provider: ReviewProvider = {
    id: "adapter",
    name: "Adapter",
    getReviews: async () => [],
    getAggregate: async () => aggregate,
  };
  const wrapped = captureReviewProviderContributors(ctx, provider);
  expect((await wrapped.getAggregate(subject)).contributors).toEqual([]);
  provider.getAggregate = async () => ({ ...aggregate, source: "declared-other" });
  expect((await wrapped.getAggregate(subject)).contributors).toEqual([]);
});

it("credits a computed aggregate as derived data, but not the reviews it was computed from", async () => {
  const ctx = createMockIntegrationContext();
  ctx.manifest.dataSources = [
    {
      sourceId: "reviews",
      name: "Review store",
      url: "https://reviews.test/",
      providerCountry: "DE",
      providerPrivacyUrl: "https://reviews.test/privacy",
      licensing: {
        version: 1,
        bindings: [
          { scope: "data", subject: "Reviews", license: { kind: "spdx", expression: "CC-BY-4.0" } },
        ],
      },
    },
  ];
  const provider: ReviewProvider = {
    id: "reviews",
    name: "Reviews",
    aggregateComputed: true,
    getReviews: async () => [{ id: "r1", source: "reviews", rating: 80 } as never],
    getAggregate: async () => aggregate,
  };
  const wrapped = captureReviewProviderContributors(ctx, provider);
  expect((await wrapped.getAggregate(subject)).contributors?.map((c) => c.modified)).toEqual([
    true,
  ]);
  const [review] = await wrapped.getReviews(subject);
  expect(review?.contributors?.map((c) => c.modified)).toEqual([undefined]);
  const stated = captureReviewProviderContributors(ctx, { ...provider, aggregateComputed: false });
  expect((await stated.getAggregate(subject)).contributors?.map((c) => c.modified)).toEqual([
    undefined,
  ]);
});
