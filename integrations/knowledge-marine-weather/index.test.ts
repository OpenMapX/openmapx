import type { RouteHandler } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCurrent,
  douglasFromWaveHeight,
  type MarineHourlyPoint,
  type OpenMeteoMarineResponse,
  parseHourly,
  setup,
} from "./index.js";

// Open-Meteo Marine returns parallel hourly arrays (wave/swell/current + a
// modeled MSL sea level). These tests pin the array-zip mapper, the Douglas Sea
// Scale classification from significant wave height, the "closest hour to now"
// current picker, and the route's inland-detection (error sentinel / all-null
// wave series → 204).

describe("douglasFromWaveHeight", () => {
  const cases: Array<[number | undefined, string]> = [
    [undefined, "calm-glassy"],
    [0, "calm-glassy"],
    [0.05, "calm-rippled"],
    [0.3, "smooth"],
    [1.0, "slight"],
    [2.0, "moderate"],
    [3.5, "rough"],
    [5.0, "very-rough"],
    [7.5, "high"],
    [12, "very-high"],
    [20, "phenomenal"],
  ];

  it.each(cases)("classifies %p m as %s", (height, expected) => {
    expect(douglasFromWaveHeight(height)).toBe(expected);
  });
});

describe("parseHourly", () => {
  it("zips the parallel arrays into points and maps null gaps to undefined", () => {
    const data: OpenMeteoMarineResponse = {
      hourly: {
        time: ["2026-06-14T00:00", "2026-06-14T01:00"],
        wave_height: [1.2, null],
        wave_direction: [210, 215],
        wave_period: [6.5, 6.7],
        wind_wave_height: [0.8, 0.9],
        wind_wave_direction: [200, 205],
        wind_wave_period: [4.0, 4.1],
        swell_wave_height: [0.9, 1.0],
        swell_wave_direction: [220, 225],
        swell_wave_period: [9.0, 9.2],
        ocean_current_velocity: [0.3, 0.4],
        ocean_current_direction: [180, 185],
        sea_level_height_msl: [0.12, -0.05],
      },
    };

    const hourly = parseHourly(data);

    expect(hourly).toHaveLength(2);
    expect(hourly[0]).toEqual({
      time: "2026-06-14T00:00",
      waveHeightM: 1.2,
      waveDirectionDeg: 210,
      wavePeriodS: 6.5,
      windWaveHeightM: 0.8,
      windWaveDirectionDeg: 200,
      windWavePeriodS: 4.0,
      swellHeightM: 0.9,
      swellDirectionDeg: 220,
      swellPeriodS: 9.0,
      currentVelocityMs: 0.3,
      currentDirectionDeg: 180,
      seaLevelHeightM: 0.12,
    });
    // null wave_height on the 2nd hour becomes undefined.
    expect(hourly[1]?.waveHeightM).toBeUndefined();
    expect(hourly[1]?.seaLevelHeightM).toBe(-0.05);
  });

  it("returns an empty array when there is no hourly block", () => {
    expect(parseHourly({})).toEqual([]);
  });
});

describe("buildCurrent", () => {
  it("returns null for an empty series", () => {
    expect(buildCurrent([])).toBeNull();
  });

  it("picks the hour closest to now and tags the Douglas sea state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T01:20:00Z"));
    const hourly: MarineHourlyPoint[] = [
      { time: "2026-06-14T00:00:00Z", waveHeightM: 0.4 },
      { time: "2026-06-14T01:00:00Z", waveHeightM: 1.4 },
      { time: "2026-06-14T02:00:00Z", waveHeightM: 3.2 },
    ];

    const current = buildCurrent(hourly);

    expect(current).toMatchObject({
      time: "2026-06-14T01:00:00Z",
      waveHeightM: 1.4,
      seaState: "moderate",
    });
    vi.useRealTimers();
  });
});

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
  const route = ctx.registered.routes.find((r) => r.path === "/marine");
  if (!route) throw new Error("/marine route was not registered");
  return route.handler;
}

async function invoke(query: Record<string, string>): Promise<FakeReply> {
  const reply = makeReply();
  await getHandler()({ query, params: {}, body: undefined, headers: {} }, reply);
  return reply;
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

describe("GET /marine route", () => {
  it("returns the mapped current + hourly payload for a coastal point", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        latitude: 54.0,
        longitude: 8.0,
        hourly: {
          time: ["2026-06-14T00:00", "2026-06-14T01:00"],
          wave_height: [0.8, 0.9],
          wave_direction: [200, 205],
          wave_period: [5.0, 5.1],
          swell_wave_height: [0.6, 0.7],
          swell_wave_direction: [210, 215],
          swell_wave_period: [8.0, 8.1],
          ocean_current_velocity: [0.2, 0.25],
          ocean_current_direction: [180, 185],
          sea_level_height_msl: [0.1, 0.15],
        },
      }),
    );

    const reply = await invoke({ lat: "54.0", lng: "8.0" });

    expect(reply.statusCode).toBe(200);
    const payload = reply.payload as {
      location: { lat: number; lng: number };
      source: string;
      current: { seaState: string };
      hourly: unknown[];
    };
    expect(payload.location).toEqual({ lat: 54.0, lng: 8.0 });
    expect(payload.source).toBe("open-meteo-marine");
    expect(payload.current.seaState).toBe("slight");
    expect(payload.hourly).toHaveLength(2);
  });

  it("400s on out-of-range coordinates without calling upstream", async () => {
    const reply = await invoke({ lat: "200", lng: "8.0" });

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ message: "Out-of-range coordinates" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("204s when Open-Meteo flags the point as inland (error sentinel)", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ error: true, reason: "no marine data" }));

    const reply = await invoke({ lat: "50.78", lng: "6.08" });

    expect(reply.statusCode).toBe(204);
    expect(reply.payload).toBeNull();
  });

  it("204s when the wave series is entirely null (silent inland grid cell)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        latitude: 50.78,
        longitude: 6.08,
        hourly: {
          time: ["2026-06-14T00:00", "2026-06-14T01:00"],
          wave_height: [null, null],
        },
      }),
    );

    const reply = await invoke({ lat: "50.78", lng: "6.08" });

    expect(reply.statusCode).toBe(204);
    expect(reply.payload).toBeNull();
  });
});
