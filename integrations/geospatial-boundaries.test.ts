import type { RouteHandler } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { parseDataSourceBBox } from "./data-source/index.js";
import { setup as setupRouting } from "./routing/index.js";
import { setup as setupTransit } from "./transit/index.js";

function route(
  setup: (ctx: ReturnType<typeof createMockIntegrationContext>) => void,
  path: string,
) {
  const ctx = createMockIntegrationContext();
  setup(ctx);
  const registration = ctx.registered.routes.find((candidate) => candidate.path === path);
  if (!registration) throw new Error(`route ${path} was not registered`);
  return registration.handler;
}

async function invoke(
  handler: RouteHandler,
  input: { query?: Record<string, string>; body?: unknown },
) {
  let statusCode = 200;
  let payload: unknown;
  const send = (data: unknown) => {
    payload = data;
  };
  await handler(
    { query: input.query ?? {}, params: {}, body: input.body, headers: {} },
    {
      send,
      status(code) {
        statusCode = code;
        return { send };
      },
      header() {},
      type() {},
    },
  );
  return { statusCode, payload };
}

describe("public integration geospatial boundaries", () => {
  it.each([
    { south: "52", west: "14", north: "53", east: "13" },
    { south: "52", west: "13", north: "91", east: "14" },
    { south: "-80", west: "-170", north: "80", east: "170" },
    { south: "-85", west: "-540", north: "85", east: "540" },
  ])("clamps reversed, out-of-range, or oversized viewport data-source bboxes", (query) => {
    const bbox = parseDataSourceBBox(query);
    expect(bbox).not.toBeNull();
    const { west, south, east, north } = bbox as NonNullable<typeof bbox>;
    expect(west).toBeGreaterThanOrEqual(-180);
    expect(east).toBeLessThanOrEqual(180);
    expect(south).toBeGreaterThanOrEqual(-90);
    expect(north).toBeLessThanOrEqual(90);
    expect(east - west).toBeGreaterThan(0);
    expect(east - west).toBeLessThanOrEqual(60);
    expect(north - south).toBeGreaterThan(0);
    expect(north - south).toBeLessThanOrEqual(30);
    expect((east - west) * (north - south)).toBeLessThanOrEqual(900.0001);
  });

  it("rejects non-finite data-source bbox input", () => {
    expect(parseDataSourceBBox({ south: "52", west: "abc", north: "53", east: "14" })).toBeNull();
  });

  it("serves reversed viewport transit longitude bounds instead of failing the request", async () => {
    const result = await invoke(route(setupTransit, "/stops"), {
      query: { sw_lat: "52", sw_lng: "14", ne_lat: "53", ne_lng: "13" },
    });
    expect(result.statusCode).toBe(200);
  });

  it("rejects non-finite transit bbox input", async () => {
    const result = await invoke(route(setupTransit, "/stops"), {
      query: { sw_lat: "52", sw_lng: "NaN", ne_lat: "53", ne_lng: "13" },
    });
    expect(result.statusCode).toBe(400);
  });

  it.each([
    { lat: "52", lng: "13", radius: "-1" },
    { lat: "90", lng: "13", radius: "500" },
    { lat: "52", lng: "13", radius: "2001" },
  ])("rejects unsafe nearby-stop inputs", async (query) => {
    const result = await invoke(route(setupTransit, "/stops/nearby"), { query });
    expect(result.statusCode).toBe(400);
  });

  it("rejects non-finite and out-of-range transit planning points", async () => {
    const result = await invoke(route(setupTransit, "/plan"), {
      query: { from_lat: "52", from_lng: "Infinity", to_lat: "52", to_lng: "181" },
    });
    expect(result.statusCode).toBe(400);
  });

  it("rejects non-finite routing shorthand coordinates", async () => {
    const result = await invoke(route(setupRouting, "/directions"), {
      query: { originLng: "Infinity", originLat: "52", destLng: "13", destLat: "52" },
    });
    expect(result.statusCode).toBe(400);
  });

  it.each([
    [Number.POSITIVE_INFINITY, 52],
    [181, 52],
    [13, 91],
  ])("rejects invalid map-match points", async (lng, lat) => {
    const result = await invoke(route(setupRouting, "/match"), {
      body: {
        trace: [
          { lng: 13, lat: 52 },
          { lng, lat },
        ],
      },
    });
    expect(result.statusCode).toBe(400);
  });

  it("rejects reversed navigation-alert bboxes and answers oversized corridors empty", async () => {
    const handler = route(setupRouting, "/navigation/alerts");
    expect((await invoke(handler, { query: { bbox: "52,14,53,13" } })).statusCode).toBe(400);
    expect((await invoke(handler, { query: { bbox: "52,x,53,14" } })).statusCode).toBe(400);
    const oversized = await invoke(handler, { query: { bbox: "40,-10,60,30" } });
    expect(oversized.statusCode).toBe(200);
    expect(oversized.payload).toEqual({ alerts: [] });
  });
});
