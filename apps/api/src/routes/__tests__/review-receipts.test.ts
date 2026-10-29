import { setup } from "@integrations/reviews/index";
import manifest from "@integrations/reviews-mangrove/manifest.json";
import type { Review, ReviewAggregate, ReviewProvider } from "@openmapx/core";
import type { LoadedIntegration } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import Fastify, { type HTTPMethods } from "fastify";
import { expect, it } from "vitest";

it("serializes captured receipts, skips old caches and invalidates both receipt-bearing reads after writes", async () => {
  const subject = { lat: 51, lng: 6, name: "Cafe" };
  let opinion = "Original opinion";
  let count = 3;
  const provider: ReviewProvider = {
    id: "mangrove",
    name: "Mangrove",
    getReviews: async () => [
      {
        id: "one",
        subject,
        author: { kid: "key" },
        createdAt: "2026-10-01",
        opinion,
        metadata: { license: "CC-BY-SA-4.0" },
      },
    ],
    getAggregate: async () => ({
      count,
      stars: 4,
      quality: 80,
      opinionCount: 1,
      positiveCount: 1,
      confirmedCount: 0,
    }),
    submit: async () => {
      opinion = "After submission";
      count = 4;
      return { id: "new" };
    },
  };
  const integration: LoadedIntegration = {
    id: "reviews-mangrove",
    manifest: structuredClone(manifest) as never,
    enabled: true,
    providers: new Map([["reviews", [provider]]]),
    config: {},
    directory: "/integrations/reviews-mangrove",
    isBuiltIn: true,
    strings: {},
    shutdownHandlers: [],
  };
  const oldList = "cache:reviews:list:51.000000:6.000000:cafe:no-osm";
  const oldAggregate = "cache:reviews:agg:51.000000:6.000000:cafe:no-osm";
  const stored = new Map<string, unknown>([
    [oldList, [{ opinion: "Obsolete review" }]],
    [oldAggregate, { count: 999 }],
  ]);
  const ctx = createMockIntegrationContext();
  ctx.getIntegrationsByDomain = () => [integration];
  ctx.cache.withCache = async <T>(
    key: string,
    _ttl: number,
    load: (signal: AbortSignal) => Promise<T>,
  ) => {
    if (!stored.has(key))
      stored.set(key, JSON.parse(JSON.stringify(await load(new AbortController().signal))));
    return stored.get(key) as T;
  };
  ctx.cache.del = async (key) => {
    stored.delete(key);
  };
  setup(ctx);
  const app = Fastify();
  for (const route of ctx.registered.routes) {
    app.route({
      method: route.method as HTTPMethods,
      url: route.path,
      handler: (request, reply) =>
        route.handler(
          {
            query: request.query as Record<string, string>,
            body: request.body,
            params: {},
            headers: request.headers,
          },
          reply as never,
        ),
    });
  }
  try {
    const query = "?lat=51&lng=6&name=Cafe";
    const firstReviews = (await app.inject(`/reviews${query}`)).json().reviews as Review[];
    const firstAggregate = (await app.inject(`/aggregate${query}`)).json()
      .aggregate as ReviewAggregate;
    expect(firstReviews[0].opinion).toBe("Original opinion");
    expect(firstReviews[0].metadata?.license).toBe("CC-BY-SA-4.0");
    expect(firstReviews[0].contributors?.[0]).toMatchObject({
      sourceId: "mangrove",
      name: "Mangrove.reviews",
      url: "https://mangrove.reviews/",
    });
    expect(firstAggregate.contributors).toEqual(firstReviews[0].contributors);
    const source = integration.manifest.dataSources?.[0];
    if (!source) throw new Error("Missing review source fixture");
    source.name = "New terms";
    integration.enabled = false;
    expect((await app.inject(`/reviews${query}`)).json().reviews[0].contributors).toEqual(
      firstReviews[0].contributors,
    );
    expect((await app.inject(`/aggregate${query}`)).json().aggregate.contributors).toEqual(
      firstAggregate.contributors,
    );
    integration.enabled = true;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/submit",
          payload: { jwt: "a.b.c", invalidate: subject },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(`/reviews${query}`)).json().reviews[0]).toMatchObject({
      opinion: "After submission",
      contributors: [{ name: "New terms" }],
    });
    expect((await app.inject(`/aggregate${query}`)).json().aggregate).toMatchObject({
      count: 4,
      contributors: [{ name: "New terms" }],
    });
    expect(stored.get(oldList)).toEqual([{ opinion: "Obsolete review" }]);
    expect(stored.get(oldAggregate)).toEqual({ count: 999 });
  } finally {
    await app.close();
  }
});
