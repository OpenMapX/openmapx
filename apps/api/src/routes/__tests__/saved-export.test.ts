import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/require-auth.js", () => ({
  requireAuthHook: vi.fn(async () => {}),
  getUserId: vi.fn(() => "user-1"),
}));

const listRows: Array<{ id: string; name: string }> = [{ id: "list-1", name: "$favorites" }];
const placeRows: Array<Record<string, unknown>> = [
  {
    id: "pl-1",
    listId: "list-1",
    name: "Brandenburg Gate",
    address: "Pariser Platz",
    lat: 52.5163,
    lng: 13.3777,
    placeId: "p-1",
    note: "Meet here",
    sortOrder: 0,
    createdAt: new Date(),
  },
];

function makeSelectChain(resolveWith: unknown[]) {
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; stub must mirror that.
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(resolveWith).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

const selectQueue: unknown[][] = [];
const mockSelect = vi.fn(() => makeSelectChain(selectQueue.shift() ?? []));

vi.mock("../../db/index.js", () => ({
  db: { select: () => mockSelect() },
}));
vi.mock("../../db/schema.js", () => ({
  savedList: { id: "id", userId: "userId", name: "name" },
  savedPlace: { id: "id", listId: "listId", sortOrder: "sortOrder" },
  labeledPlace: {},
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { savedRoute } = await import("../saved.js");
  app = Fastify();
  await app.register(savedRoute, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function primeListAndPlaces() {
  selectQueue.length = 0;
  selectQueue.push([...listRows], [...placeRows]);
}

describe("GET /api/saved/lists/:id/export", () => {
  it("defaults to geojson and returns a FeatureCollection with [lng,lat]", async () => {
    primeListAndPlaces();
    const res = await app.inject({ method: "GET", url: "/api/saved/lists/list-1/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/geo+json");
    const fc = res.json();
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features[0].geometry.coordinates).toEqual([13.3777, 52.5163]);
  });

  it("exports GPX with the right content type and filename", async () => {
    primeListAndPlaces();
    const res = await app.inject({
      method: "GET",
      url: "/api/saved/lists/list-1/export?format=gpx",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/gpx+xml");
    expect(res.headers["content-disposition"]).toContain('filename="favorites.gpx"');
    expect(res.body).toContain('<wpt lat="52.5163" lon="13.3777">');
  });

  it("exports KML", async () => {
    primeListAndPlaces();
    const res = await app.inject({
      method: "GET",
      url: "/api/saved/lists/list-1/export?format=kml",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("kml");
    expect(res.body).toContain("<coordinates>13.3777,52.5163</coordinates>");
  });

  it("404s when the list is not owned / not found", async () => {
    selectQueue.length = 0;
    selectQueue.push([]);
    const res = await app.inject({ method: "GET", url: "/api/saved/lists/nope/export" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an invalid format with 400", async () => {
    primeListAndPlaces();
    const res = await app.inject({
      method: "GET",
      url: "/api/saved/lists/list-1/export?format=csv",
    });
    expect(res.statusCode).toBe(400);
  });
});
