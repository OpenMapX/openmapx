import type { HotelOffer, HotelOffersResponse } from "@openmapx/core/server";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
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
