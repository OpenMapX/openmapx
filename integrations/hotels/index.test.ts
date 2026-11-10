import type { HotelOffer, HotelOffersResponse } from "@openmapx/core/server";
import {
  createFencedMemoryCache,
  createMockIntegrationContext,
} from "@openmapx/integration-framework/testing";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "./index.js";

const searchOffer = vi.hoisted(() => vi.fn());
vi.mock("./provider.js", () => ({ createLiteApiProvider: () => ({ searchOffer }) }));
afterEach(() => vi.resetAllMocks());
const offer: HotelOffer = {
  source: "liteapi",
  total: 150,
  nightlyFrom: 75,
  currency: "EUR",
  refundable: true,
};

it("retains acquisition-time hotel receipts across metadata changes and cache hits", async () => {
  const values = new Map<string, unknown>();
  const ctx = createMockIntegrationContext({ config: { liteApiKey: "test" } });
  ctx.cache.get = async <T>(key: string) => (values.get(key) as T) ?? null;
  ctx.cache.set = async (key, value) => {
    values.set(key, structuredClone(value));
  };
  let name = "Acquired terms";
  Object.defineProperty(ctx, "attributionIndex", {
    value: {
      getById: () => ({ sourceId: "liteapi", name, url: "https://rates.example/terms" }),
    } as typeof ctx.attributionIndex,
  });
  searchOffer.mockImplementation(async () => {
    name = "Changed during acquisition";
    return offer;
  });
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/offers");
  if (!route) throw new Error("missing offers route");
  const read = async () => {
    let body: unknown;
    const reply = {
      header: () => {},
      status: () => reply,
      send: (value: unknown) => {
        body = value;
      },
      type: () => {},
    };
    await route.handler(
      {
        params: {},
        headers: {},
        body: null,
        query: {
          name: "Hotel",
          lat: "52",
          lng: "13",
          checkIn: "2026-10-20",
          checkOut: "2026-10-22",
        },
      },
      reply,
    );
    return body as HotelOffersResponse;
  };
  const first = await read();
  expect(first.best?.contributors).toEqual([
    { sourceId: "liteapi", name: "Acquired terms", url: "https://rates.example/terms" },
  ]);
  name = "Current terms";
  expect((await read()).best?.contributors).toEqual(first.best?.contributors);
});

it.each([
  { contributors: [] },
  { contributors: [{ sourceId: "native", name: "Native rate terms" }] },
])("preserves native hotel receipt ownership %j", async ({ contributors }) => {
  const ctx = createMockIntegrationContext({ config: { liteApiKey: "test" } });
  searchOffer.mockResolvedValue({ ...offer, contributors });
  setup(ctx);
  let body: unknown;
  const reply = {
    header: () => {},
    status: () => reply,
    send: (value: unknown) => {
      body = value;
    },
    type: () => {},
  };
  const route = ctx.registered.routes.find((r) => r.path === "/offers");
  if (!route) throw new Error("missing offers route");
  await route.handler(
    {
      params: {},
      headers: {},
      body: null,
      query: {
        name: "Hotel",
        lat: "52",
        lng: "13",
        checkIn: "2026-10-20",
        checkOut: "2026-10-22",
      },
    },
    reply,
  );
  expect((body as HotelOffersResponse).best?.contributors).toEqual(contributors);
});

async function readOffer(ctx: ReturnType<typeof createMockIntegrationContext>, name: string) {
  const route = ctx.registered.routes.find((r) => r.path === "/offers");
  if (!route) throw new Error("missing offers route");
  const reply = { header: () => reply, status: () => reply, send: () => reply, type: () => reply };
  await route.handler(
    {
      params: {},
      headers: {},
      body: null,
      query: { name, lat: "52", lng: "13", checkIn: "2026-10-20", checkOut: "2026-10-22" },
      clientKey: "test-client",
    },
    reply,
  );
}

it("keeps a rate fetched across an admin cache clear out of the cache", async () => {
  const cache = createFencedMemoryCache();
  const ctx = createMockIntegrationContext({ config: { liteApiKey: "test" }, cache });
  let release!: () => void;
  let searching!: () => void;
  const started = new Promise<void>((resolve) => {
    searching = resolve;
  });
  searchOffer.mockImplementation(async () => {
    searching();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return offer;
  });
  setup(ctx);

  const request = readOffer(ctx, "Hotel");
  await started;
  cache.clear();
  release();
  await request;

  expect(cache.values.size).toBe(0);
});

it("stores rates and no-availability answers with their own TTLs", async () => {
  const cache = createFencedMemoryCache();
  const ctx = createMockIntegrationContext({ config: { liteApiKey: "test" }, cache });
  searchOffer.mockResolvedValueOnce(offer).mockResolvedValueOnce(null);
  setup(ctx);

  await readOffer(ctx, "Available");
  await readOffer(ctx, "Full");

  const entries = [...cache.ttls].map(([key, ttl]) => [
    key.split(":")[3],
    ttl,
    cache.values.get(key),
  ]);
  expect(entries).toEqual([
    ["available", 15 * 60, expect.objectContaining({ total: 150 })],
    ["full", 3 * 60, ""],
  ]);
});
