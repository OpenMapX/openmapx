import { nth } from "@openmapx/integration-framework/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const overpassQuerySafe = vi.fn();

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  overpassQuerySafe: (...args: unknown[]) => overpassQuerySafe(...args),
}));

import {
  buildLandmarksQuery,
  landmarkCacheKey,
  mapLandmarkElements,
  type OverpassLandmarkElement,
  parseLandmarkPoints,
} from "../navigation-landmarks.js";
import {
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./support/routing-handler-contract.js";

const POINT = { lat: 52.520_01, lon: 13.404_96 };
const FAR = { lat: 52.53, lon: 13.42 };

const node = (id: number, tags: Record<string, string>, lat = 52.5201, lon = 13.405) =>
  ({ type: "node", id, lat, lon, tags }) as OverpassLandmarkElement;

const CHURCH_WAY: OverpassLandmarkElement = {
  type: "way",
  id: 10,
  tags: { amenity: "place_of_worship", religion: "christian", building: "church" },
  geometry: [
    { lat: 52.5202, lon: 13.4051 },
    { lat: 52.5204, lon: 13.4051 },
    { lat: 52.5204, lon: 13.4054 },
    { lat: 52.5202, lon: 13.4051 },
  ],
};

describe("parseLandmarkPoints", () => {
  it("rejects 0 and 41 points", () => {
    expect(parseLandmarkPoints({ points: [] })).toBeNull();
    expect(parseLandmarkPoints({ points: Array.from({ length: 41 }, () => POINT) })).toBeNull();
    expect(parseLandmarkPoints({ points: Array.from({ length: 40 }, () => POINT) })).toHaveLength(
      40,
    );
  });

  it("rejects malformed bodies and coordinates", () => {
    expect(parseLandmarkPoints(null)).toBeNull();
    expect(parseLandmarkPoints({})).toBeNull();
    expect(parseLandmarkPoints({ points: [{ lat: 91, lon: 0 }] })).toBeNull();
    expect(parseLandmarkPoints({ points: [{ lat: "north", lon: 13 }] })).toBeNull();
    expect(parseLandmarkPoints({ points: [{ lat: 52 }] })).toBeNull();
    expect(parseLandmarkPoints({ points: [null] })).toBeNull();
  });

  it("rounds coordinates", () => {
    expect(parseLandmarkPoints({ points: [POINT] })).toEqual([{ lat: 52.52, lon: 13.405 }]);
  });
});

describe("buildLandmarksQuery", () => {
  it("builds one around:150 query for all points", () => {
    const query = buildLandmarksQuery([
      { lat: 52.52, lon: 13.405 },
      { lat: 52.53, lon: 13.42 },
    ]);
    expect(query.match(/around:150,52\.52,13\.405\)/g)?.length).toBeGreaterThan(0);
    expect(query).toContain("around:150,52.53,13.42)");
    expect(query).toContain("out tags geom");
    expect(query).toContain("out center tags");
    expect(query.startsWith("[out:json]")).toBe(true);
  });
});

describe("mapLandmarkElements", () => {
  it("returns allowlisted candidates only", () => {
    const candidates = mapLandmarkElements(
      [
        node(1, { amenity: "fuel", brand: "Aral" }),
        node(2, { amenity: "pharmacy", brand: "DocMorris" }),
        node(3, { shop: "supermarket", brand: "REWE" }),
        node(4, { amenity: "bank", brand: "Sparkasse" }),
        node(5, { shop: "bakery" }),
        node(6, { amenity: "fuel" }),
      ],
      { lat: 52.52, lon: 13.405 },
    );
    expect(candidates).toEqual([
      { category: "fuel", brand: "Aral", lat: 52.5201, lon: 13.405 },
      { category: "pharmacy", brand: "DocMorris", lat: 52.5201, lon: 13.405 },
      { category: "supermarket", brand: "REWE", lat: 52.5201, lon: 13.405 },
      { category: "fuel", lat: 52.5201, lon: 13.405 },
    ]);
  });

  it("place of worship needs a building and an allowed religion", () => {
    const candidates = mapLandmarkElements(
      [
        CHURCH_WAY,
        node(20, { amenity: "place_of_worship", religion: "christian" }),
        node(21, { amenity: "place_of_worship", religion: "buddhist", building: "yes" }),
        node(22, { amenity: "place_of_worship", religion: "muslim", building: "mosque" }),
        { ...CHURCH_WAY, id: 23, tags: { ...CHURCH_WAY.tags, building: "no" } },
      ],
      { lat: 52.52, lon: 13.405 },
    );
    expect(candidates).toHaveLength(2);
    expect(nth(candidates, 0)).toMatchObject({
      category: "place_of_worship",
      religion: "christian",
      lat: 52.5203,
      lon: 13.40525,
    });
    expect(nth(candidates, 0).outline).toEqual([
      [13.4051, 52.5202],
      [13.4051, 52.5204],
      [13.4054, 52.5204],
      [13.4051, 52.5202],
    ]);
    expect(nth(candidates, 1)).toMatchObject({ category: "place_of_worship", religion: "muslim" });
  });

  it("fast food needs a brand", () => {
    const candidates = mapLandmarkElements(
      [
        node(30, { amenity: "fast_food", name: "Imbiss" }),
        node(31, { amenity: "fast_food", brand: "McDonald's" }),
        node(32, { amenity: "fast_food", brand: "x".repeat(41) }),
      ],
      { lat: 52.52, lon: 13.405 },
    );
    expect(candidates).toEqual([
      { category: "fast_food", brand: "McDonald's", lat: 52.5201, lon: 13.405 },
    ]);
  });

  it("drops an over-long brand on other categories but keeps the candidate", () => {
    expect(
      mapLandmarkElements([node(33, { amenity: "fuel", brand: "x".repeat(41) })], {
        lat: 52.52,
        lon: 13.405,
      }),
    ).toEqual([{ category: "fuel", lat: 52.5201, lon: 13.405 }]);
  });

  it("keeps only candidates near the point", () => {
    expect(
      mapLandmarkElements([node(40, { amenity: "fuel" }, 52.53, 13.42)], {
        lat: 52.52,
        lon: 13.405,
      }),
    ).toEqual([]);
  });

  it("skips a way without usable geometry rather than placing it at 0° N 0° E", () => {
    const broken = {
      type: "way",
      id: 60,
      tags: { amenity: "fuel" },
      geometry: [null, { lat: Number.NaN, lon: 13.4 }],
    } as unknown as OverpassLandmarkElement;
    expect(mapLandmarkElements([broken], { lat: 0, lon: 0 })).toEqual([]);
  });

  it("uses a relation's centre", () => {
    const relation = {
      type: "relation",
      id: 50,
      tags: { shop: "supermarket", building: "retail" },
      center: { lat: 52.5203, lon: 13.4052 },
    } as OverpassLandmarkElement;
    expect(mapLandmarkElements([relation], { lat: 52.52, lon: 13.405 })).toEqual([
      { category: "supermarket", lat: 52.5203, lon: 13.4052 },
    ]);
  });
});

describe("POST /navigation/landmarks", () => {
  beforeEach(() => overpassQuerySafe.mockReset());

  function environment() {
    const store = new Map<string, unknown>();
    const cache = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    };
    const env = createRoutingHandlerEnvironment({
      routingProviders: [],
      contextOverrides: { cache: cache as never },
    });
    return { env, cache, store };
  }

  it("returns 400 for an invalid body", async () => {
    const { env } = environment();
    const reply = createRoutingTestReply();
    await env.getHandler("/navigation/landmarks")({ body: { points: [] }, query: {} }, reply);
    expect(reply.code).toBe(400);
  });

  it("answers per point from one query and caches each point for a week", async () => {
    overpassQuerySafe.mockResolvedValue({
      elements: [node(1, { amenity: "fuel", brand: "Aral" })],
    });
    const { env, cache } = environment();
    const reply = createRoutingTestReply();
    await env.getHandler("/navigation/landmarks")(
      { body: { points: [POINT, FAR] }, query: {} },
      reply,
    );
    expect(reply.body).toEqual({
      results: [
        { candidates: [{ category: "fuel", brand: "Aral", lat: 52.5201, lon: 13.405 }] },
        { candidates: [] },
      ],
    });
    expect(overpassQuerySafe).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(2);
    expect(nth(cache.set.mock.calls, 0)[2]).toBe(7 * 86_400);
  });

  it("a remark answer is unavailable and not cached", async () => {
    overpassQuerySafe.mockResolvedValue({ elements: [], remark: "runtime error: timeout" });
    const { env, cache } = environment();
    const reply = createRoutingTestReply();
    await env.getHandler("/navigation/landmarks")({ body: { points: [POINT] }, query: {} }, reply);
    expect(reply.body).toEqual({ results: [{ candidates: [], unavailable: true }] });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("a failed query is unavailable and not cached", async () => {
    overpassQuerySafe.mockResolvedValue(null);
    const { env, cache } = environment();
    const reply = createRoutingTestReply();
    await env.getHandler("/navigation/landmarks")({ body: { points: [POINT] }, query: {} }, reply);
    expect(reply.body).toEqual({ results: [{ candidates: [], unavailable: true }] });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("a cached point skips the query", async () => {
    const { env, store } = environment();
    store.set(landmarkCacheKey({ lat: 52.52, lon: 13.405 }), {
      candidates: [{ category: "pharmacy", lat: 52.52, lon: 13.405 }],
    });
    const reply = createRoutingTestReply();
    await env.getHandler("/navigation/landmarks")({ body: { points: [POINT] }, query: {} }, reply);
    expect(overpassQuerySafe).not.toHaveBeenCalled();
    expect(reply.body).toEqual({
      results: [{ candidates: [{ category: "pharmacy", lat: 52.52, lon: 13.405 }] }],
    });
  });

  it("queries only the uncached points", async () => {
    overpassQuerySafe.mockResolvedValue({ elements: [] });
    const { env, store } = environment();
    store.set(landmarkCacheKey({ lat: 52.52, lon: 13.405 }), { candidates: [] });
    await env.getHandler("/navigation/landmarks")(
      { body: { points: [POINT, FAR] }, query: {} },
      createRoutingTestReply(),
    );
    const query = String(nth(overpassQuerySafe.mock.calls, 0)[0]);
    expect(query).toContain("52.53,13.42");
    expect(query).not.toContain("52.52,13.405");
  });
});
