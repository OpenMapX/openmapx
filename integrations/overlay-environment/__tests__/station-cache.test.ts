import {
  createFencedMemoryCache,
  createMockIntegrationContext,
} from "@openmapx/integration-framework/testing";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "../index";

afterEach(() => vi.unstubAllGlobals());

interface Box {
  _id: string;
  currentLocation: { coordinates: [number, number] };
}

/** An openSenseMap box with one measured temperature sensor. */
const box = (id: string, lng: number, lat: number) => ({
  _id: id,
  name: id,
  currentLocation: { coordinates: [lng, lat] as [number, number] },
  exposure: "outdoor",
  sensors: [
    {
      title: "Temperature",
      unit: "°C",
      sensorType: "t",
      lastMeasurement: { value: "20", createdAt: "2026-01-01" },
    },
  ],
});

/** Upstream that answers openSenseMap with only the boxes inside the requested bbox. */
function honoringUpstream(boxes: Box[], sensorCommunity: unknown[] = []) {
  const fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("opensensemap")) {
      const match = /bbox=([^&]+)/.exec(u);
      if (!match) throw new Error(`openSenseMap URL without bbox: ${u}`);
      const [west, south, east, north] = match[1].split(",").map(Number);
      const inside = (b: Box) => {
        const [lng, lat] = b.currentLocation.coordinates;
        return lat >= south && lat <= north && lng >= west && lng <= east;
      };
      return Response.json(boxes.filter(inside));
    }
    if (u.includes("data.sensor.community")) return Response.json(sensorCommunity);
    throw new Error(`Unexpected upstream URL: ${u}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const openSenseMapCalls = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.filter(([u]) => String(u).includes("opensensemap"));

function stationsRoute() {
  const cache = createFencedMemoryCache();
  const ctx = createMockIntegrationContext({ cache });
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/stations");
  if (!route) throw new Error("Missing /stations route");
  return { route, cache };
}

type Route = ReturnType<typeof stationsRoute>["route"];

async function request(route: Route, query: Record<string, string>) {
  let status: number | undefined;
  let body: unknown;
  const reply = {
    send: (value: unknown) => {
      body = value;
    },
    status: (code: number) => {
      status = code;
      return reply;
    },
  };
  await route.handler({ query: { sensor: "temperature", ...query } } as never, reply as never);
  return { status, body };
}

const ids = (body: unknown) => (body as { id: string }[]).map((s) => s.id);

const wideArea = { south: "50", west: "5", north: "52", east: "7" };

it("serves each viewport sharing a cache key the stations inside its own bbox", async () => {
  const fetch = honoringUpstream([box("P1", 6.415, 50.415), box("P2", 6.445, 50.445)]);
  const { route } = stationsRoute();

  const a = await request(route, { south: "50.41", west: "6.41", north: "50.44", east: "6.44" });
  expect(ids(a.body)).toEqual(["P1"]);

  const b = await request(route, {
    south: "50.43",
    west: "6.43",
    north: "50.449",
    east: "6.449",
  });
  expect(ids(b.body)).toEqual(["P2"]);

  const calls = openSenseMapCalls(fetch);
  expect(calls).toHaveLength(1);
  expect(String(calls[0][0])).toContain("bbox=6.4,50.4,6.5,50.5");
});

it("does not cache a failed upstream read, so the next request retries and returns data", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("down", { status: 503 })),
  );
  const { route, cache } = stationsRoute();

  const failed = await request(route, wideArea);
  expect(failed.status).toBe(502);
  expect(cache.values.size).toBe(0);

  const fetch = honoringUpstream([box("station", 6, 51)]);
  const retried = await request(route, wideArea);
  expect(retried.status).not.toBe(502);
  expect(ids(retried.body)).toEqual(["station"]);
  expect(openSenseMapCalls(fetch)).toHaveLength(1);
});

it("serves a partial read without caching it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("opensensemap")
        ? new Response("down", { status: 503 })
        : Response.json([
            {
              id: 1,
              timestamp: "2026-01-01",
              location: { id: 7, latitude: "51", longitude: "6", indoor: 0 },
              sensor: { id: 1, sensor_type: { name: "BME280" } },
              sensordatavalues: [{ value_type: "temperature", value: "20" }],
            },
          ]),
    ),
  );
  const { route, cache } = stationsRoute();

  const partial = await request(route, wideArea);
  expect(ids(partial.body)).toEqual(["sc-7"]);
  expect(cache.values.size).toBe(0);
});

it("still caches a complete successful read", async () => {
  const fetch = honoringUpstream([box("station", 6, 51)]);
  const { route, cache } = stationsRoute();

  const first = await request(route, wideArea);
  const second = await request(route, wideArea);
  expect(second.body).toEqual(first.body);
  expect(openSenseMapCalls(fetch)).toHaveLength(1);
  expect(cache.values.size).toBe(1);
  expect([...cache.ttls.values()]).toEqual([600]);
});
