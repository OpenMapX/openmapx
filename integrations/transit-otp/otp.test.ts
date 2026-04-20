import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core", () => ({
  decodePolyline: vi.fn(() => []),
  otpMode: vi.fn((mode: string) => {
    if (mode === "WALK") return "walking";
    if (mode === "BUS") return "bus";
    if (mode === "RAIL") return "rail";
    return "bus";
  }),
}));

import { isOtpAvailable, plan, setOtpUrl } from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

function mockNotOk(status = 500) {
  return { ok: false, status } as Response;
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setOtpUrl("http://otp.example");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setOtpUrl("http://localhost:8090");
});

describe("OTP transit provider", () => {
  it("checks availability against the configured OTP base URL", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    const available = await isOtpAvailable();

    expect(available).toBe(true);
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe("http://otp.example/otp/routers/default");
  });

  it("normalizes OTP v1 plan responses", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);
    mockFetch.mockResolvedValueOnce(
      mockOk({
        plan: {
          from: { name: "Start", lat: 48.1, lon: 11.5 },
          to: { name: "End", lat: 48.2, lon: 11.6 },
          itineraries: [
            {
              duration: 900,
              startTime: new Date("2026-03-10T10:00:00Z").getTime(),
              endTime: new Date("2026-03-10T10:15:00Z").getTime(),
              transfers: 1,
              walkDistance: 320,
              legs: [
                {
                  mode: "BUS",
                  startTime: new Date("2026-03-10T10:05:00Z").getTime(),
                  endTime: new Date("2026-03-10T10:15:00Z").getTime(),
                  from: { name: "Start", lat: 48.1, lon: 11.5 },
                  to: { name: "End", lat: 48.2, lon: 11.6, stopId: "stop-1" },
                  routeShortName: "42",
                  routeLongName: "Bus 42",
                  routeColor: "FF5500",
                  tripId: "trip-v1",
                },
              ],
            },
          ],
        },
      }),
    );

    const result = await plan({
      fromLat: 48.1,
      fromLng: 11.5,
      toLat: 48.2,
      toLng: 11.6,
      date: "2026-03-10",
      time: "10:00:00",
      modes: "WALK,TRANSIT",
    });

    expect(result?.itineraries[0]).toMatchObject({
      duration: 900,
      startTime: "2026-03-10T10:00:00.000Z",
      endTime: "2026-03-10T10:15:00.000Z",
      transfers: 1,
      walkDistance: 320,
    });
    expect(result?.itineraries[0]?.legs[0]).toMatchObject({
      mode: "bus",
      tripId: "trip-v1",
      route: {
        shortName: "42",
        longName: "Bus 42",
        color: "FF5500",
      },
    });
  });

  it("normalizes OTP v2 route and trip fields and returns null on planner errors", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);
    mockFetch.mockResolvedValueOnce(
      mockOk({
        plan: {
          from: { name: "A", lat: 48.1, lon: 11.5 },
          to: { name: "B", lat: 48.2, lon: 11.6 },
          itineraries: [
            {
              duration: 600,
              startTime: new Date("2026-03-10T10:00:00Z").getTime(),
              endTime: new Date("2026-03-10T10:10:00Z").getTime(),
              transfers: 0,
              walkDistance: 0,
              legs: [
                {
                  mode: "RAIL",
                  startTime: new Date("2026-03-10T10:00:00Z").getTime(),
                  endTime: new Date("2026-03-10T10:10:00Z").getTime(),
                  from: { name: "A", lat: 48.1, lon: 11.5 },
                  to: { name: "B", lat: 48.2, lon: 11.6 },
                  route: { shortName: "S1", longName: "S-Bahn 1", color: "#00AA44" },
                  trip: { gtfsId: "agency:trip-v2" },
                },
              ],
            },
          ],
        },
      }),
    );

    const result = await plan({
      fromLat: 48.1,
      fromLng: 11.5,
      toLat: 48.2,
      toLng: 11.6,
      time: "10:00:00",
    });

    expect(result?.itineraries[0]?.legs[0]).toMatchObject({
      mode: "rail",
      tripId: "agency:trip-v2",
      route: {
        shortName: "S1",
        longName: "S-Bahn 1",
        color: "00AA44",
      },
    });

    mockFetch.mockResolvedValueOnce({ ok: true } as Response);
    mockFetch.mockResolvedValueOnce(mockNotOk(500));

    const failingResult = await plan({
      fromLat: 48.1,
      fromLng: 11.5,
      toLat: 48.2,
      toLng: 11.6,
      time: "10:00:00",
    });

    expect(failingResult).toBeNull();
  });
});
