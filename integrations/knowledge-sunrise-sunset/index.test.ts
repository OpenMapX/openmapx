import type { RouteHandler } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

// The /times route resolves the IANA zone from the coordinate (geo-tz), then
// queries sunrise-sunset.org with `formatted=0` (ISO output). These tests pin
// the snake_case → camelCase field remap, the attached attribution block, the
// timezone passthrough, and the error branches (bad coords, non-OK upstream,
// non-"OK" API status).

interface FakeReply {
  header: (k: string, v: string) => FakeReply;
  send: (p: unknown) => FakeReply;
  status: (n: number) => FakeReply;
  payload: unknown;
  statusCode: number;
  headers: Record<string, string>;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    payload: undefined,
    statusCode: 200,
    headers: {},
    header(k, v) {
      reply.headers[k] = v;
      return reply;
    },
    send(p) {
      reply.payload = p;
      return reply;
    },
    status(n) {
      reply.statusCode = n;
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
  const route = ctx.registered.routes.find((r) => r.path === "/times");
  if (!route) throw new Error("/times route was not registered");
  return route.handler;
}

async function invoke(query: Record<string, string>): Promise<FakeReply> {
  const reply = makeReply();
  await getHandler()({ query, params: {}, body: undefined, headers: {} }, reply);
  return reply;
}

function apiBody() {
  return {
    status: "OK",
    tzid: "Europe/Berlin",
    results: {
      sunrise: "2026-06-14T03:13:42+00:00",
      sunset: "2026-06-14T19:33:11+00:00",
      solar_noon: "2026-06-14T11:23:26+00:00",
      day_length: 58769,
      civil_twilight_begin: "2026-06-14T02:30:01+00:00",
      civil_twilight_end: "2026-06-14T20:16:52+00:00",
      nautical_twilight_begin: "2026-06-14T01:25:09+00:00",
      nautical_twilight_end: "2026-06-14T21:21:44+00:00",
      astronomical_twilight_begin: "2026-06-14T00:00:00+00:00",
      astronomical_twilight_end: "2026-06-14T22:00:00+00:00",
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

describe("GET /times sunrise-sunset route", () => {
  it("maps the snake_case API payload to camelCase and attaches attribution", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(apiBody()));

    const reply = await invoke({ lat: "52.52", lng: "13.405" });

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({
      sunrise: "2026-06-14T03:13:42+00:00",
      sunset: "2026-06-14T19:33:11+00:00",
      solarNoon: "2026-06-14T11:23:26+00:00",
      dayLength: 58769,
      civilTwilightBegin: "2026-06-14T02:30:01+00:00",
      civilTwilightEnd: "2026-06-14T20:16:52+00:00",
      nauticalTwilightBegin: "2026-06-14T01:25:09+00:00",
      nauticalTwilightEnd: "2026-06-14T21:21:44+00:00",
      astronomicalTwilightBegin: "2026-06-14T00:00:00+00:00",
      astronomicalTwilightEnd: "2026-06-14T22:00:00+00:00",
      timezone: "Europe/Berlin",
      attribution: { name: "Sunrise-Sunset.org", url: "https://sunrise-sunset.org/" },
    });
    expect(reply.headers["Cache-Control"]).toBe("public, max-age=3600");
  });

  it("resolves the IANA zone from the coordinate and requests ISO output", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(apiBody()));

    await invoke({ lat: "52.52", lng: "13.405" });

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("lat=52.52&lng=13.405");
    expect(url).toContain("formatted=0");
    expect(url).toContain("tzid=Europe%2FBerlin");
  });

  it("400s on non-numeric coordinates without calling upstream", async () => {
    const reply = await invoke({ lat: "abc", lng: "13.4" });

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ message: "Invalid coordinates" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("502s when the upstream returns a non-OK HTTP status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    const reply = await invoke({ lat: "52.52", lng: "13.405" });

    expect(reply.statusCode).toBe(502);
    expect(reply.payload).toEqual({ message: "Sunrise-Sunset data unavailable" });
  });

  it("502s when the API reports a non-OK status string", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({ status: "INVALID_REQUEST", tzid: "UTC", results: {} }),
    );

    const reply = await invoke({ lat: "52.52", lng: "13.405" });

    expect(reply.statusCode).toBe(502);
    expect(reply.payload).toEqual({ message: "Sunrise-Sunset API error: INVALID_REQUEST" });
  });

  it("502s when the fetch itself throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const reply = await invoke({ lat: "52.52", lng: "13.405" });

    expect(reply.statusCode).toBe(502);
    expect(reply.payload).toEqual({ message: "Sunrise-Sunset data unavailable" });
  });
});
