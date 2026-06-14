import type { RouteHandler } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

// The /aqi route pulls Open-Meteo's `current` block and renames each pollutant
// to the app's camelCase field (pm2_5 → pm25, nitrogen_dioxide → no2, …),
// passing the European/US AQI indices through unchanged. These tests pin that
// remap, null passthrough, the coordinate validation branches, and the upstream
// error handling.

interface FakeReply {
  send: (p: unknown) => FakeReply;
  status: (n: number) => FakeReply;
  header: (k: string, v: string) => FakeReply;
  type: (c: string) => FakeReply;
  payload: unknown;
  statusCode: number;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    payload: undefined,
    statusCode: 200,
    send(p) {
      reply.payload = p;
      return reply;
    },
    status(n) {
      reply.statusCode = n;
      return reply;
    },
    header() {
      return reply;
    },
    type() {
      return reply;
    },
  };
  return reply;
}

function mockOk(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

function getHandler(): RouteHandler {
  const ctx = createMockIntegrationContext();
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/aqi");
  if (!route) throw new Error("/aqi route was not registered");
  return route.handler;
}

async function invoke(query: Record<string, string>): Promise<FakeReply> {
  const reply = makeReply();
  await getHandler()({ query, params: {}, body: undefined }, reply);
  return reply;
}

function apiBody() {
  return {
    latitude: 52.52,
    longitude: 13.4,
    current: {
      time: "2026-06-14T12:00",
      pm10: 18.4,
      pm2_5: 9.7,
      carbon_monoxide: 142,
      nitrogen_dioxide: 12.5,
      sulphur_dioxide: 1.8,
      ozone: 76,
      european_aqi: 31,
      us_aqi: 42,
    },
  };
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /aqi air-quality route", () => {
  it("renames pollutant fields and passes the AQI indices and units through", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(apiBody()));

    const reply = await invoke({ lat: "52.52", lng: "13.4" });

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({
      pm25: 9.7,
      pm10: 18.4,
      no2: 12.5,
      o3: 76,
      so2: 1.8,
      co: 142,
      europeanAqi: 31,
      usAqi: 42,
      time: "2026-06-14T12:00",
    });
  });

  it("requests the current pollutant + AQI fields at rounded coordinates", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(apiBody()));

    await invoke({ lat: "52.5234", lng: "13.4012" });

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("latitude=52.52&longitude=13.4");
    expect(url).toContain("current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide");
    expect(url).toContain("european_aqi,us_aqi");
  });

  it("passes null pollutant readings through unchanged", async () => {
    const body = apiBody();
    body.current.pm2_5 = null as unknown as number;
    body.current.european_aqi = null as unknown as number;
    mockFetch.mockResolvedValueOnce(mockOk(body));

    const reply = await invoke({ lat: "52.52", lng: "13.4" });

    expect(reply.payload).toMatchObject({ pm25: null, europeanAqi: null });
  });

  it("400s on non-numeric coordinates without calling upstream", async () => {
    const reply = await invoke({ lat: "x", lng: "13.4" });

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ message: "lat and lng query parameters are required" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("400s on out-of-range coordinates", async () => {
    const reply = await invoke({ lat: "120", lng: "13.4" });

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ message: "lat must be -90..90, lng must be -180..180" });
  });

  it("502s when the upstream returns a non-OK HTTP status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const reply = await invoke({ lat: "52.52", lng: "13.4" });

    expect(reply.statusCode).toBe(502);
    expect(reply.payload).toEqual({ message: "Upstream air quality API error" });
  });
});
