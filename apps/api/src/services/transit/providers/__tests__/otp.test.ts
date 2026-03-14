import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock global fetch — otp.ts calls global fetch for isOtpAvailable and plan
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  // Default OTP URL (uses env or fallback)
  process.env.OTP_URL = "http://localhost:8090";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.OTP_URL;
});

function mockOk(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

function mockNotOk(status = 500) {
  return { ok: false, status } as Response;
}

// Dynamic import to pick up stubbed fetch
async function loadModule() {
  return import("../otp.js");
}

/** Build a minimal OTP v1 itinerary object */
function buildItinerary(overrides: Record<string, unknown> = {}) {
  return {
    duration: 1200, // seconds
    startTime: new Date("2026-03-10T10:00:00Z").getTime(), // ms epoch
    endTime: new Date("2026-03-10T10:20:00Z").getTime(),
    transfers: 1,
    walkDistance: 350,
    legs: [],
    ...overrides,
  };
}

/** Build a minimal OTP v1 leg */
function buildLeg(overrides: Record<string, unknown> = {}) {
  return {
    mode: "WALK",
    startTime: new Date("2026-03-10T10:00:00Z").getTime(),
    endTime: new Date("2026-03-10T10:05:00Z").getTime(),
    from: { name: "Origin", lat: 48.1, lon: 11.5 },
    to: { name: "Destination", lat: 48.15, lon: 11.55 },
    legGeometry: { points: "" }, // empty encoded polyline
    ...overrides,
  };
}

describe("otp provider", () => {
  describe("isOtpAvailable", () => {
    it("returns true when router endpoint responds with ok", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);

      const { isOtpAvailable } = await loadModule();
      const available = await isOtpAvailable();

      expect(available).toBe(true);
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("/otp/routers/default");
    });

    it("returns false when router endpoint responds with non-ok status", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk(503));

      const { isOtpAvailable } = await loadModule();
      const available = await isOtpAvailable();

      expect(available).toBe(false);
    });

    it("returns false when fetch throws (network error)", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const { isOtpAvailable } = await loadModule();
      const available = await isOtpAvailable();

      expect(available).toBe(false);
    });

    it("uses OTP_URL env variable", async () => {
      process.env.OTP_URL = "http://my-otp-server:9090";
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);

      const { isOtpAvailable } = await loadModule();
      await isOtpAvailable();

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("my-otp-server:9090");
    });
  });

  describe("plan", () => {
    const defaultParams = {
      fromLat: 48.1,
      fromLng: 11.5,
      toLat: 48.2,
      toLng: 11.6,
      date: "2026-03-10",
      time: "10:00:00",
      modes: "WALK,TRANSIT",
    };

    it("returns null when OTP is not available", async () => {
      // isOtpAvailable check fails
      mockFetch.mockResolvedValueOnce(mockNotOk(503));

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result).toBeNull();
    });

    it("returns TripPlan with duration in seconds (not ms)", async () => {
      // First call: isOtpAvailable → ok
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      // Second call: plan endpoint
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "Start", lat: 48.1, lon: 11.5 },
            to: { name: "End", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({ duration: 900 }), // 900 seconds = 15 min
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result).not.toBeNull();
      expect(result?.itineraries[0].duration).toBe(900); // still 900, not 900000
    });

    it("returns TripPlan with correct from/to names", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "Hauptbahnhof", lat: 48.14, lon: 11.56 },
            to: { name: "Marienplatz", lat: 48.137, lon: 11.576 },
            itineraries: [],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result?.from.name).toBe("Hauptbahnhof");
      expect(result?.from.lat).toBe(48.14);
      expect(result?.from.lng).toBe(11.56);
      expect(result?.to.name).toBe("Marienplatz");
    });

    it("maps WALK leg mode → walking", async () => {
      const startMs = new Date("2026-03-10T10:00:00Z").getTime();
      const endMs = new Date("2026-03-10T10:05:00Z").getTime();

      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({
                legs: [buildLeg({ mode: "WALK", startTime: startMs, endTime: endMs })],
              }),
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result?.itineraries[0].legs[0].mode).toBe("walking");
    });

    it("WALK leg has no route property", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [buildItinerary({ legs: [buildLeg({ mode: "WALK" })] })],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result?.itineraries[0].legs[0].route).toBeUndefined();
    });

    it("supports OTP v1 format: routeShortName at leg top level", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({
                legs: [
                  buildLeg({
                    mode: "BUS",
                    routeShortName: "42",
                    routeLongName: "Bus Line 42",
                    routeColor: "FF5500",
                  }),
                ],
              }),
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      if (!result) throw new Error("result was null");
      const leg = result.itineraries[0].legs[0];
      if (!leg) throw new Error("leg was undefined");
      expect(leg.mode).toBe("bus");
      expect(leg.route?.shortName).toBe("42");
      expect(leg.route?.longName).toBe("Bus Line 42");
      expect(leg.route?.color).toBe("FF5500");
    });

    it("supports OTP v2 format: route.shortName nested in leg.route", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({
                legs: [
                  buildLeg({
                    mode: "RAIL",
                    route: {
                      shortName: "S1",
                      longName: "S-Bahn 1",
                      color: "00AA44",
                    },
                  }),
                ],
              }),
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      if (!result) throw new Error("result was null");
      const leg = result.itineraries[0].legs[0];
      if (!leg) throw new Error("leg was undefined");
      expect(leg.mode).toBe("rail");
      expect(leg.route?.shortName).toBe("S1");
      expect(leg.route?.longName).toBe("S-Bahn 1");
      expect(leg.route?.color).toBe("00AA44");
    });

    it("strips leading # from route color", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({
                legs: [
                  buildLeg({
                    mode: "BUS",
                    route: { shortName: "1", longName: "Line 1", color: "#FF0000" },
                  }),
                ],
              }),
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result?.itineraries[0].legs[0].route?.color).toBe("FF0000");
    });

    it("sets _intermediateStopCount from intermediateStops.length", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({
                legs: [
                  buildLeg({
                    mode: "RAIL",
                    routeShortName: "S3",
                    routeLongName: "S-Bahn 3",
                    intermediateStops: [{}, {}, {}], // 3 stops
                  }),
                ],
              }),
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result?.itineraries[0].legs[0]._intermediateStopCount).toBe(3);
    });

    it("sets _intermediateStopCount to undefined when no intermediateStops", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({
                legs: [buildLeg({ mode: "WALK" })],
              }),
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result?.itineraries[0].legs[0]._intermediateStopCount).toBeUndefined();
    });

    it("converts leg startTime/endTime from ms epoch to ISO string", async () => {
      const startMs = new Date("2026-03-10T10:00:00Z").getTime();
      const endMs = new Date("2026-03-10T10:20:00Z").getTime();

      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({
                legs: [buildLeg({ mode: "WALK", startTime: startMs, endTime: endMs })],
              }),
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      if (!result) throw new Error("result was null");
      const leg = result.itineraries[0].legs[0];
      if (!leg) throw new Error("leg was undefined");
      expect(leg.startTime).toBe("2026-03-10T10:00:00.000Z");
      expect(leg.endTime).toBe("2026-03-10T10:20:00.000Z");
    });

    it("converts itinerary startTime/endTime from ms epoch to ISO string", async () => {
      const startMs = new Date("2026-03-10T09:30:00Z").getTime();
      const endMs = new Date("2026-03-10T10:00:00Z").getTime();

      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [buildItinerary({ startTime: startMs, endTime: endMs })],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result?.itineraries[0].startTime).toBe("2026-03-10T09:30:00.000Z");
      expect(result?.itineraries[0].endTime).toBe("2026-03-10T10:00:00.000Z");
    });

    it("maps leg from.lon → leg.from.lng (lon vs lng)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({
                legs: [
                  buildLeg({
                    mode: "WALK",
                    from: { name: "Start", lat: 48.1, lon: 11.5 },
                    to: { name: "Stop", lat: 48.12, lon: 11.52, stopId: "stop-1" },
                  }),
                ],
              }),
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      if (!result) throw new Error("result was null");
      const leg = result.itineraries[0].legs[0];
      if (!leg) throw new Error("leg was undefined");
      expect(leg.from.lng).toBe(11.5); // converted from lon
      expect(leg.to.lng).toBe(11.52);
      expect(leg.to.stopId).toBe("stop-1");
    });

    it("supports OTP v1 tripId at leg top level", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({
                legs: [
                  buildLeg({
                    mode: "BUS",
                    routeShortName: "5",
                    routeLongName: "Bus 5",
                    tripId: "trip-v1-123",
                  }),
                ],
              }),
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result?.itineraries[0].legs[0].tripId).toBe("trip-v1-123");
    });

    it("supports OTP v2 tripId via leg.trip.gtfsId", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [
              buildItinerary({
                legs: [
                  buildLeg({
                    mode: "RAIL",
                    route: { shortName: "ICE", longName: "ICE 100" },
                    trip: { gtfsId: "agency:trip-v2-456" },
                  }),
                ],
              }),
            ],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result?.itineraries[0].legs[0].tripId).toBe("agency:trip-v2-456");
    });

    it("returns null on plan endpoint non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response); // isOtpAvailable
      mockFetch.mockResolvedValueOnce(mockNotOk(500)); // plan

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result).toBeNull();
    });

    it("returns null when response contains error field", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          error: { id: 404, msg: "Path not found" },
          plan: null,
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result).toBeNull();
    });

    it("returns null on fetch exception", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response); // isOtpAvailable
      mockFetch.mockRejectedValueOnce(new Error("network error")); // plan fetch fails

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result).toBeNull();
    });

    it("includes arriveBy=true in URL when param set", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [],
          },
        }),
      );

      const { plan } = await loadModule();
      await plan({ ...defaultParams, arriveBy: true });

      const planUrl = mockFetch.mock.calls[1][0] as string;
      expect(planUrl).toContain("arriveBy=true");
    });

    it("does not include arriveBy in URL when not set", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [],
          },
        }),
      );

      const { plan } = await loadModule();
      await plan(defaultParams);

      const planUrl = mockFetch.mock.calls[1][0] as string;
      expect(planUrl).not.toContain("arriveBy");
    });

    it("uses numItineraries param in URL, defaults to 3", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [],
          },
        }),
      );

      const { plan } = await loadModule();
      await plan(defaultParams);

      const planUrl = mockFetch.mock.calls[1][0] as string;
      expect(planUrl).toContain("numItineraries=3");
    });

    it("uses walkDistance from itinerary", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [buildItinerary({ walkDistance: 650.7 })],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      // Math.round applied
      expect(result?.itineraries[0].walkDistance).toBe(651);
    });

    it("uses transfers count from itinerary", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      mockFetch.mockResolvedValueOnce(
        mockOk({
          plan: {
            from: { name: "A", lat: 48.1, lon: 11.5 },
            to: { name: "B", lat: 48.2, lon: 11.6 },
            itineraries: [buildItinerary({ transfers: 2 })],
          },
        }),
      );

      const { plan } = await loadModule();
      const result = await plan(defaultParams);

      expect(result?.itineraries[0].transfers).toBe(2);
    });
  });
});
