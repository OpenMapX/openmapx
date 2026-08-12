import type { CacheClient, RouteHandler } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  type MockContextOverrides,
} from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wraps the real `geo-tz` `find` in a spy that calls through by default, so
// every existing test keeps resolving real zones, while a couple of new
// tests can assert exactly which coordinates `find` was invoked with (or
// override its return once) without touching module-namespace properties
// directly — ESM namespace objects reject `vi.spyOn` ("Module namespace is
// not configurable"), so this indirection through `vi.hoisted` is required.
const { mockedFindTimezone } = vi.hoisted(() => ({ mockedFindTimezone: vi.fn() }));

vi.mock("geo-tz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("geo-tz")>();
  mockedFindTimezone.mockImplementation(actual.find);
  return { ...actual, find: mockedFindTimezone };
});

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

// Collects handlers by path so both /times and /timezone can be exercised
// from the same harness.
function getHandler(path: string, overrides: MockContextOverrides = {}): RouteHandler {
  const ctx = createMockIntegrationContext(overrides);
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === path);
  if (!route) throw new Error(`${path} route was not registered`);
  return route.handler;
}

async function invoke(
  path: string,
  query: Record<string, string>,
  overrides: MockContextOverrides = {},
): Promise<FakeReply> {
  const reply = makeReply();
  // The real dispatcher always passes headers, even when empty — mirror
  // that shape so this mock cannot drift from what handlers actually receive.
  await getHandler(path, overrides)({ query, params: {}, body: undefined, headers: {} }, reply);
  return reply;
}

// In-memory CacheClient double with vi.fn spies, so tests can assert the
// exact key/value/TTL a handler used, not just that caching "worked".
function makeCache(initial: Record<string, unknown> = {}): CacheClient & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    withCache: vi.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
  } as unknown as CacheClient & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
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
  // vi.restoreAllMocks() below only restores vi.spyOn spies, so this plain
  // vi.fn()'s call history would otherwise accumulate across tests.
  mockedFindTimezone.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /times sunrise-sunset route", () => {
  it("maps the snake_case API payload to camelCase and attaches attribution", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(apiBody()));

    const reply = await invoke("/times", { lat: "52.52", lng: "13.405" });

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

    await invoke("/times", { lat: "52.52", lng: "13.405" });

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("lat=52.52&lng=13.405");
    expect(url).toContain("formatted=0");
    expect(url).toContain("tzid=Europe%2FBerlin");
  });

  it("400s on non-numeric coordinates without calling upstream", async () => {
    const reply = await invoke("/times", { lat: "abc", lng: "13.4" });

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ message: "Invalid coordinates" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("400s on out-of-range coordinates instead of crashing on the geo-tz lookup", async () => {
    // geo-tz's `find` throws on out-of-range input rather than returning an
    // empty array. Before this guard, lat=200 reached `findTimezone` ahead
    // of the try/catch and the throw propagated as an unhandled 500.
    const reply = await invoke("/times", { lat: "200", lng: "13.4" });

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ message: "Invalid coordinates" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("502s when the upstream returns a non-OK HTTP status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    const reply = await invoke("/times", { lat: "52.52", lng: "13.405" });

    expect(reply.statusCode).toBe(502);
    expect(reply.payload).toEqual({ message: "Sunrise-Sunset data unavailable" });
  });

  it("502s when the API reports a non-OK status string", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({ status: "INVALID_REQUEST", tzid: "UTC", results: {} }),
    );

    const reply = await invoke("/times", { lat: "52.52", lng: "13.405" });

    expect(reply.statusCode).toBe(502);
    expect(reply.payload).toEqual({ message: "Sunrise-Sunset API error: INVALID_REQUEST" });
  });

  it("502s when the fetch itself throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const reply = await invoke("/times", { lat: "52.52", lng: "13.405" });

    expect(reply.statusCode).toBe(502);
    expect(reply.payload).toEqual({ message: "Sunrise-Sunset data unavailable" });
  });
});

// /timezone returns only the zone id — no fetch involved, so these tests
// never stub `fetch` and instead drive a real CacheClient double to pin the
// cache key shape and TTL.
describe("GET /timezone route", () => {
  it("resolves a land coordinate to its IANA zone", async () => {
    const reply = await invoke(
      "/timezone",
      { lat: "52.52", lng: "13.405" },
      { cache: makeCache() },
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ timezone: "Europe/Berlin" });
    expect(reply.headers["Cache-Control"]).toBe("public, max-age=86400");
  });

  it("still resolves an ocean coordinate to a truthy zone id", async () => {
    // geo-tz falls back to a 15-degree-wide Etc/GMT band whenever no land
    // polygon covers the point, so mid-ocean coordinates always resolve —
    // they never hit the `findTimezone(...)[0] ?? "UTC"` fallback.
    const reply = await invoke("/timezone", { lat: "0", lng: "-160" }, { cache: makeCache() });

    expect(reply.statusCode).toBe(200);
    const { timezone } = reply.payload as { timezone: string };
    expect(timezone).toBeTruthy();
    expect(typeof timezone).toBe("string");
  });

  it("400s on non-numeric coordinates without touching the cache", async () => {
    const cache = makeCache();

    const reply = await invoke("/timezone", { lat: "abc", lng: "13.4" }, { cache });

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ message: "Invalid coordinates" });
    expect(cache.get).not.toHaveBeenCalled();
  });

  it("400s on out-of-range coordinates instead of throwing", async () => {
    // geo-tz's `find` throws on out-of-range input (e.g. lat > 90) rather
    // than returning an empty array, so range must be validated before the
    // lookup runs or this crashes the handler instead of 400ing.
    const cache = makeCache();

    const reply = await invoke("/timezone", { lat: "200", lng: "13.4" }, { cache });

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ message: "Invalid coordinates" });
    expect(cache.get).not.toHaveBeenCalled();
  });

  it("stores a fresh lookup under the rounded-coordinate key with a 30-day TTL", async () => {
    const cache = makeCache();

    await invoke("/timezone", { lat: "52.5243", lng: "13.40567" }, { cache });

    expect(cache.get).toHaveBeenCalledWith("tz:52.5243,13.4057");
    expect(cache.set).toHaveBeenCalledWith(
      "tz:52.5243,13.4057",
      { timezone: "Europe/Berlin" },
      2_592_000,
    );
  });

  it("short-circuits on a cache hit without recomputing or re-storing", async () => {
    const cache = makeCache({ "tz:52.52,13.405": { timezone: "Fake/Zone" } });

    const reply = await invoke("/timezone", { lat: "52.52", lng: "13.405" }, { cache });

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({ timezone: "Fake/Zone" });
    expect(reply.headers["Cache-Control"]).toBe("public, max-age=86400");
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("looks up and caches from the rounded coordinate, not the raw one", async () => {
    // 52.520001/13.405001 and 52.519999/13.404999 both round4 to
    // 52.52/13.405 — the same cache key. If the lookup used the raw
    // coordinate while the cache key used the rounded one, the key and the
    // value it caches could silently disagree near a real boundary. Forcing
    // a distinguishable return value proves which coordinate actually
    // reached `findTimezone`.
    const cache = makeCache();
    mockedFindTimezone.mockReturnValueOnce(["Rounded/Zone"]);

    const first = await invoke("/timezone", { lat: "52.520001", lng: "13.405001" }, { cache });

    expect(mockedFindTimezone).toHaveBeenCalledWith(52.52, 13.405);
    expect(first.payload).toEqual({ timezone: "Rounded/Zone" });
    expect(cache.set).toHaveBeenCalledWith(
      "tz:52.52,13.405",
      { timezone: "Rounded/Zone" },
      2_592_000,
    );

    mockedFindTimezone.mockClear();

    // A neighbor that rounds to the same key must hit the cache, not run a
    // second (and potentially divergent) lookup.
    const second = await invoke("/timezone", { lat: "52.519999", lng: "13.404999" }, { cache });

    expect(second.payload).toEqual(first.payload);
    expect(mockedFindTimezone).not.toHaveBeenCalled();
  });
});
