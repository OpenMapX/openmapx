import type { SharedRequestPolicy, UpstreamRuntime } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index";
import manifest from "./manifest.json";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing provider method");
  return value;
}
function fixture(
  apiKey: string | undefined = "fixture-key",
  respond: (url: string) => unknown = () => ({ data: [] }),
  onPolicyCheck: () => void = () => {},
) {
  const shared = {
    admitSharedRequest: vi.fn(
      async (_input: { scope: string; key: string; policy?: SharedRequestPolicy }) => ({
        allowed: true as const,
        remaining: 999,
      }),
    ),
    deferSharedRequests: vi.fn(async () => {}),
  };
  const http = fakeHttpClient((request) => respond(request.url));
  const mock = createMockIntegrationContext({
    id: "transit-mbta",
    manifest,
    config: { apiKey },
    http,
  });
  const shutdown: (() => Promise<void>)[] = [];
  let denied = new Set<string>();
  const ctx = {
    ...mock,
    upstreamRuntime: shared as unknown as UpstreamRuntime,
    onShutdown: (fn: () => Promise<void>) => {
      shutdown.push(fn);
    },
    getDisallowedSourceIds: async () => {
      onPolicyCheck();
      return denied;
    },
  };
  setup(ctx);
  return {
    ctx,
    http,
    shared,
    shutdown,
    provider: Object.assign(mock.registered.transit[0], {
      getStopsNearby: required(mock.registered.transit[0].getStopsNearby),
      getStop: required(mock.registered.transit[0].getStop),
      getDepartures: required(mock.registered.transit[0].getDepartures),
      getVehiclePositions: required(mock.registered.transit[0].getVehiclePositions),
      getFacilities: required(mock.registered.transit[0].getFacilities),
      getAlertsForStop: required(mock.registered.transit[0].getAlertsForStop),
      getAlertsForRoute: required(mock.registered.transit[0].getAlertsForRoute),
    }),
    health: mock.registered.healthChecks[0],
    deny: (id = "mbta") => {
      denied = new Set([id]);
    },
  };
}
beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Global fetch is forbidden: use host HTTP");
    }),
  ),
);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const stop = (id = "70067", latitude = 42.36, longitude = -71.06) => ({
  type: "stop",
  id,
  attributes: { name: "Harvard", latitude, longitude, vehicle_type: 1, platform_code: "A" },
});
describe("MBTA complete host-owned integration", () => {
  it("maps nearby stops, uses angular radius, and excludes actual metre-radius misses", async () => {
    const f = fixture("fixture-key", () => ({
      data: [
        stop(),
        stop("east-inside", 42.36, -71.049),
        stop("north-inside", 42.368, -71.06),
        stop("far", 42.38, -71.06),
      ],
    }));
    const result = await f.provider.getStopsNearby(42.36, -71.06, 1000);
    expect(result.data.map((s) => s.id)).toEqual(["mb:70067", "mb:east-inside", "mb:north-inside"]);
    expect(Number(new URL(f.http.calls[0].url).searchParams.get("filter[radius]"))).toBeLessThan(
      0.02,
    );
    expect(f.http.calls[0].url).not.toContain("api_key");
    expect(result.data[0].contributors?.[0].sourceId).toBe("mbta");
  });
  it("looks up stops and exposes only the existing seven methods", async () => {
    const f = fixture("fixture-key", () => ({ data: stop() }));
    expect((await f.provider.getStop("mb:70067")).data?.id).toBe("mb:70067");
    expect(f.provider.capabilities.routes).toEqual({
      lookup: false,
      forStop: false,
      stops: false,
      geometry: false,
    });
    expect(f.provider.getRoute).toBeUndefined();
    expect(f.provider.getRouteStops).toBeUndefined();
  });
  it("maps documented prediction, trip and stop fields and preserves schedule delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const f = fixture("fixture-key", () => ({
      data: [
        {
          type: "prediction",
          id: "p",
          attributes: { departure_time: "2026-10-22T12:05:00Z", trip_headsign: "Alewife" },
          relationships: {
            route: { data: { id: "Red", type: "route" } },
            trip: { data: { id: "t", type: "trip" } },
            stop: { data: { id: "70067", type: "stop" } },
            schedule: { data: { id: "s", type: "schedule" } },
          },
        },
      ],
      included: [
        {
          type: "route",
          id: "Red",
          attributes: { short_name: "Red", long_name: "Red Line", type: 1 },
        },
        { type: "stop", id: "70067", attributes: { platform_code: "A" } },
        { type: "trip", id: "t", attributes: { headsign: "Ashmont" } },
        {
          type: "schedule",
          id: "s",
          attributes: { departure_time: "2026-10-22T12:03:00Z", arrival_time: null },
        },
      ],
    }));
    const d = await f.provider.getDepartures("mb:70067", 30);
    expect(d.data[0]).toMatchObject({
      tripId: "mb:t",
      headsign: "Alewife",
      platform: "A",
      delaySeconds: 120,
    });
    expect(new URL(f.http.calls[0].url).searchParams.get("include")).toBe(
      "route,schedule,trip,stop",
    );
  });
  it("maps vehicles and elevator/escalator facilities", async () => {
    const f = fixture("fixture-key", (url) =>
      url.includes("/vehicles")
        ? {
            data: [
              {
                type: "vehicle",
                id: "v",
                attributes: {
                  latitude: 42.36,
                  longitude: -71.06,
                  updated_at: "2026-10-22T12:00:00Z",
                },
                relationships: {
                  trip: { data: { id: "t", type: "trip" } },
                  stop: { data: { id: "70067", type: "stop" } },
                },
              },
            ],
          }
        : {
            data: [
              {
                type: "facility",
                id: "f",
                attributes: {
                  type: "ELEVATOR",
                  long_name: "Elevator 1",
                  properties: [{ name: "accessibility-accessible", value: 1 }],
                },
              },
            ],
          },
    );
    expect((await f.provider.getVehiclePositions("mb:Red")).data[0]).toMatchObject({
      tripId: "mb:t",
      currentStopId: "mb:70067",
      updatedAt: "2026-10-22T12:00:00Z",
    });
    expect((await f.provider.getFacilities("mb:70067")).data[0]).toMatchObject({
      id: "mb:f",
      stopId: "mb:70067",
      name: "Elevator 1",
      type: "elevator",
      isAccessible: true,
    });
  });
  it("maps both stop and route alerts with open-ended periods and affected identities", async () => {
    const f = fixture("fixture-key", () => ({
      data: [
        {
          type: "alert",
          id: "a",
          attributes: {
            severity: 8,
            header: "Diversion",
            informed_entity: [{ stop: "70067", route: "Red" }],
            active_period: [{ start: "2026-10-22T12:00:00Z", end: null }],
          },
        },
      ],
    }));
    const byStop = await f.provider.getAlertsForStop("mb:70067");
    const byRoute = await f.provider.getAlertsForRoute("mb:Red");
    expect(byStop.data[0]).toMatchObject({
      severity: "severe",
      affectedStopIds: ["mb:70067"],
      affectedRouteIds: ["mb:Red"],
      activePeriods: [{ start: "2026-10-22T12:00:00Z", end: undefined }],
    });
    expect(byRoute.data).toEqual(byStop.data);
    expect(new URL(f.http.calls[0].url).searchParams.get("filter[stop]")).toBe("70067");
    expect(new URL(f.http.calls[1].url).searchParams.get("filter[route]")).toBe("Red");
  });
  it("requires a key consistently for all seven methods and health", async () => {
    const f = fixture("");
    for (const call of [
      () => f.provider.getStopsNearby(42.36, -71.06, 1000),
      () => f.provider.getDepartures("70067", 30),
      () => f.provider.getVehiclePositions("Red"),
      () => f.provider.getFacilities("70067"),
      () => f.provider.getAlertsForStop("70067"),
      () => f.provider.getAlertsForRoute("Red"),
    ])
      expect((await call()).data).toEqual([]);
    expect((await f.provider.getStop("70067")).data).toBeNull();
    expect(await f.health()).toMatchObject({ status: "unconfigured" });
    expect(f.http.calls).toHaveLength(0);
  });
  it("keeps two instance credentials independent and shares admission identity only for equal keys", async () => {
    const a = fixture("first", () => ({ data: stop() }));
    const b = fixture("second", () => ({ data: stop() }));
    const same = fixture("first", () => ({ data: stop() }));
    await a.provider.getStop("70067");
    await b.provider.getStop("70067");
    await same.provider.getStop("70067");
    expect(a.http.calls[0].options?.headers?.["x-api-key"]).toBe("first");
    expect(b.http.calls[0].options?.headers?.["x-api-key"]).toBe("second");
    const identity = (f: typeof a) => f.shared.admitSharedRequest.mock.calls[0][0].key;
    expect(identity(a)).toBe(identity(same));
    expect(identity(a)).not.toBe(identity(b));
  });
  it.each(["mbta", "transit-mbta"])(
    "enforces source/integration policy %s on calls and health",
    async (id) => {
      const f = fixture();
      f.deny(id);
      await expect(f.provider.getStop("70067")).rejects.toMatchObject({ kind: "policy" });
      expect(await f.health()).toMatchObject({ status: "down" });
      expect(f.http.calls).toHaveLength(0);
    },
  );
  it("registers shutdown and rejects a late HTTP response from the retired instance", async () => {
    let release: (body: unknown) => void = () => {};
    const body = new Promise((resolve) => {
      release = resolve;
    });
    const f = fixture();
    const pendingHttp = vi
      .spyOn(f.http, "getResponse")
      .mockImplementation(async () => ({ status: 200, headers: {}, body: await body }) as never);
    const pending = f.provider.getStop("70067");
    const rejection = expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    await vi.waitFor(() => expect(pendingHttp).toHaveBeenCalledTimes(1));
    await Promise.all(f.shutdown.map((fn) => fn()));
    release({ data: stop() });
    await rejection;
    await expect(f.provider.getStop("70067")).rejects.toMatchObject({ kind: "cancelled" });
  });
  it.each(["result", "health"] as const)(
    "does not publish %s after retirement during the final continuation",
    async (kind) => {
      let checks = 0;
      let retired = false;
      function later(n: number, fn: () => void): void {
        if (n === 0) fn();
        else queueMicrotask(() => later(n - 1, fn));
      }
      const f = fixture(
        "fixture-key",
        () => ({ data: kind === "result" ? stop() : [] }),
        () => {
          // Result publication adds one final availability assertion after acquisition.
          if (++checks === (kind === "result" ? 6 : 5))
            later(kind === "result" ? 5 : 7, () => {
              retired = true;
              for (const shutdown of f.shutdown) void shutdown();
            });
        },
      );
      const original = Date.prototype.toISOString;
      let publishedAfterRetirement = false;
      vi.spyOn(Date.prototype, "toISOString").mockImplementation(function (this: Date) {
        if (retired) publishedAfterRetirement = true;
        return original.call(this);
      });
      if (kind === "result")
        await expect(f.provider.getStop("70067")).rejects.toMatchObject({ kind: "cancelled" });
      else expect(await f.health()).toMatchObject({ status: "down" });
      expect(retired).toBe(true);
      expect(publishedAfterRetirement).toBe(false);
    },
  );
  it("uses the same bounded client, key and shared quota for health", async () => {
    const f = fixture();
    expect(await f.health()).toMatchObject({ status: "up" });
    expect(f.shared.admitSharedRequest).toHaveBeenCalledTimes(1);
    expect(f.http.calls[0].options?.headers?.["x-api-key"]).toBe("fixture-key");
  });
});

it("maps a missing stop to canonical null rather than an acquisition failure", async () => {
  const f = fixture("fixture-key", () => ({ status: 404, headers: {}, body: { errors: [] } }));
  expect((await f.provider.getStop("mb:missing")).data).toBeNull();
});
