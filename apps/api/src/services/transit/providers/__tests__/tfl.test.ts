import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  process.env.TFL_API_KEY = "test-tfl-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TFL_API_KEY;
});

function mockOk(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

function mockNotOk() {
  return { ok: false, status: 500 } as Response;
}

async function loadModule() {
  return import("../tfl.js");
}

describe("tfl provider", () => {
  describe("getStops", () => {
    it("returns empty array without API key", async () => {
      delete process.env.TFL_API_KEY;

      const { getStops } = await loadModule();
      const stops = await getStops(51.5, -0.1, 500);

      expect(stops).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("maps tube to subway and elizabeth-line to rail", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stopPoints: [
            {
              naptanId: "940GZZLUOXC",
              commonName: "Oxford Circus",
              lat: 51.5152,
              lon: -0.1415,
              modes: ["tube"],
            },
            {
              naptanId: "910GPADTLL",
              commonName: "Paddington (Elizabeth line)",
              lat: 51.5167,
              lon: -0.1769,
              modes: ["elizabeth-line"],
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops(51.51, -0.14, 800);

      expect(stops).toHaveLength(2);
      expect(stops[0].id).toBe("tfl:940GZZLUOXC");
      expect(stops[0].modes).toEqual(["subway"]);
      expect(stops[0].provider).toBe("tfl");

      expect(stops[1].id).toBe("tfl:910GPADTLL");
      expect(stops[1].modes).toEqual(["rail"]);
    });

    it("clamps radius to 1000", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ stopPoints: [] }));

      const { getStops } = await loadModule();
      await getStops(51.5, -0.1, 5000);

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("radius=1000");
    });

    it("maps multiple mode types correctly", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stopPoints: [
            { naptanId: "s1", commonName: "S1", lat: 0, lon: 0, modes: ["bus"] },
            { naptanId: "s2", commonName: "S2", lat: 0, lon: 0, modes: ["tram"] },
            { naptanId: "s3", commonName: "S3", lat: 0, lon: 0, modes: ["river-bus"] },
            { naptanId: "s4", commonName: "S4", lat: 0, lon: 0, modes: ["cable-car"] },
            { naptanId: "s5", commonName: "S5", lat: 0, lon: 0, modes: ["dlr"] },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops(51.5, -0.1, 500);

      expect(stops[0].modes).toEqual(["bus"]);
      expect(stops[1].modes).toEqual(["tram"]);
      expect(stops[2].modes).toEqual(["ferry"]);
      expect(stops[3].modes).toEqual(["cable_car"]);
      expect(stops[4].modes).toEqual(["subway"]); // dlr → subway
    });
  });

  describe("getStop", () => {
    it("returns a single stop by naptan ID", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          naptanId: "940GZZLUOXC",
          commonName: "Oxford Circus",
          lat: 51.5152,
          lon: -0.1415,
          modes: ["tube"],
        }),
      );

      const { getStop } = await loadModule();
      const stop = await getStop("tfl:940GZZLUOXC");

      expect(stop).not.toBeNull();
      expect(stop?.id).toBe("tfl:940GZZLUOXC");
      expect(stop?.name).toBe("Oxford Circus");
    });

    it("strips tfl: prefix before API call", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(null));

      const { getStop } = await loadModule();
      await getStop("tfl:940GZZLUOXC");

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("/StopPoint/940GZZLUOXC");
    });

    it("returns null without API key", async () => {
      delete process.env.TFL_API_KEY;

      const { getStop } = await loadModule();
      const stop = await getStop("tfl:test");

      expect(stop).toBeNull();
    });
  });

  describe("searchByName", () => {
    it("returns matched stops", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          matches: [
            {
              naptanId: "940GZZLUOXC",
              commonName: "Oxford Circus",
              lat: 51.5152,
              lon: -0.1415,
              modes: ["tube"],
            },
          ],
        }),
      );

      const { searchByName } = await loadModule();
      const results = await searchByName("Oxford", 5);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("tfl:940GZZLUOXC");
    });

    it("returns empty array without API key", async () => {
      delete process.env.TFL_API_KEY;

      const { searchByName } = await loadModule();
      const results = await searchByName("test");

      expect(results).toEqual([]);
    });
  });

  describe("getDepartures", () => {
    it("filters by timeToStation and sets scheduledAt=expectedAt", async () => {
      const expectedArrival = "2026-03-10T10:05:00Z";

      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            vehicleId: "v1",
            lineId: "central",
            lineName: "Central",
            modeName: "tube",
            destinationName: "Ealing Broadway",
            expectedArrival,
            timeToStation: 120, // 2 minutes — within window
            platformName: "Eastbound",
          },
          {
            vehicleId: "v2",
            lineId: "central",
            lineName: "Central",
            modeName: "tube",
            destinationName: "Epping",
            expectedArrival: "2026-03-10T11:00:00Z",
            timeToStation: 3700, // ~61 minutes — outside a 60-min window
            platformName: "Westbound",
          },
        ]),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tfl:940GZZLUOXC", 60);

      // Only the first departure should be within the 60-minute window (3600 seconds)
      expect(deps).toHaveLength(1);
      expect(deps[0].tripId).toBe("v1");
      expect(deps[0].route.id).toBe("tfl:central");
      expect(deps[0].route.shortName).toBe("Central");
      expect(deps[0].route.mode).toBe("subway");
      expect(deps[0].headsign).toBe("Ealing Broadway");
      // TfL is real-time only: scheduledAt = expectedAt
      expect(deps[0].scheduledAt).toBe(expectedArrival);
      expect(deps[0].expectedAt).toBe(expectedArrival);
      expect(deps[0].platform).toBe("Eastbound");
      expect(deps[0].canceled).toBe(false);
    });

    it("strips tfl: prefix before API call", async () => {
      mockFetch.mockResolvedValueOnce(mockOk([]));

      const { getDepartures } = await loadModule();
      await getDepartures("tfl:940GZZLUOXC", 30);

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("/StopPoint/940GZZLUOXC/Arrivals");
      expect(fetchUrl).not.toContain("tfl%3A");
    });

    it("returns empty array without API key", async () => {
      delete process.env.TFL_API_KEY;

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tfl:test", 30);

      expect(deps).toEqual([]);
    });
  });

  describe("getStopAlerts", () => {
    it("maps disruption categories to severity", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            description: "Planned engineering work",
            additionalInfo: "Details here",
            category: "PlannedWork",
            disruptedRouteId: "central",
          },
          {
            description: "Station closure due to emergency",
            category: "RealTime Closure",
          },
        ]),
      );

      const { getStopAlerts } = await loadModule();
      const alerts = await getStopAlerts("tfl:940GZZLUOXC");

      expect(alerts).toHaveLength(2);

      // "planned" in category → info
      expect(alerts[0].severity).toBe("info");
      expect(alerts[0].affectedRouteIds).toEqual(["tfl:central"]);
      expect(alerts[0].affectedStopIds).toEqual(["tfl:940GZZLUOXC"]);

      // "closure" in category → severe
      expect(alerts[1].severity).toBe("severe");
    });
  });

  describe("getRouteAlerts", () => {
    it("strips tfl: prefix from lineId in URL", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            id: "central",
            name: "Central",
            lineStatuses: [
              {
                statusSeverity: 5,
                statusSeverityDescription: "Minor Delays",
              },
            ],
          },
        ]),
      );

      const { getRouteAlerts } = await loadModule();
      const alerts = await getRouteAlerts("tfl:central");

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain("/Line/central/Status");
      expect(fetchUrl).not.toContain("tfl%3A");

      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("warning");
      expect(alerts[0].title).toContain("Central");
    });

    it("filters out Good Service (severity >= 10)", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            id: "central",
            name: "Central",
            lineStatuses: [
              {
                statusSeverity: 10,
                statusSeverityDescription: "Good Service",
              },
            ],
          },
        ]),
      );

      const { getRouteAlerts } = await loadModule();
      const alerts = await getRouteAlerts("tfl:central");

      expect(alerts).toEqual([]);
    });
  });

  describe("getAlerts", () => {
    it("maps line status to alerts", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            id: "central",
            name: "Central",
            lineStatuses: [
              {
                statusSeverity: 5,
                statusSeverityDescription: "Minor Delays",
                reason: "Reason <b>html</b> stripped",
              },
            ],
          },
        ]),
      );

      const { getAlerts } = await loadModule();
      const alerts = await getAlerts();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("warning");
      expect(alerts[0].description).toBe("Reason html stripped");
      expect(alerts[0].affectedRouteIds).toEqual(["tfl:central"]);
    });

    it("filters out Good Service lines", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            id: "central",
            name: "Central",
            lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: "Good Service" }],
          },
        ]),
      );

      const { getAlerts } = await loadModule();
      const alerts = await getAlerts();

      expect(alerts).toEqual([]);
    });

    it("maps severity >= 9 to info", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            id: "jubilee",
            name: "Jubilee",
            lineStatuses: [{ statusSeverity: 9, statusSeverityDescription: "Minor Delays" }],
          },
        ]),
      );

      const { getAlerts } = await loadModule();
      const alerts = await getAlerts();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("info");
    });

    it("maps severity < 1 to critical", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            id: "central",
            name: "Central",
            lineStatuses: [{ statusSeverity: 0 }],
          },
        ]),
      );

      const { getAlerts } = await loadModule();
      const alerts = await getAlerts();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("critical");
    });

    it("maps severity 1-4 to severe", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            id: "central",
            name: "Central",
            lineStatuses: [{ statusSeverity: 3 }],
          },
        ]),
      );

      const { getAlerts } = await loadModule();
      const alerts = await getAlerts();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("severe");
    });

    it("returns empty array without API key", async () => {
      delete process.env.TFL_API_KEY;

      const { getAlerts } = await loadModule();
      const alerts = await getAlerts();

      expect(alerts).toEqual([]);
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getAlerts } = await loadModule();
      const alerts = await getAlerts();

      expect(alerts).toEqual([]);
    });

    it("handles line with no lineStatuses", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([{ id: "central", name: "Central", lineStatuses: [] }]),
      );

      const { getAlerts } = await loadModule();
      const alerts = await getAlerts();

      expect(alerts).toEqual([]);
    });
  });

  describe("getDepartures edge cases", () => {
    it("handles minimal arrival data with fallbacks", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            // minimal data — many fields missing
            timeToStation: 60,
            modeName: "unknown-mode",
          },
        ]),
      );

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tfl:test", 30);

      expect(deps).toHaveLength(1);
      expect(deps[0].tripId).toBe("");
      expect(deps[0].route.id).toBe("tfl:");
      expect(deps[0].route.shortName).toBe("");
      expect(deps[0].route.mode).toBe("bus"); // unknown mode falls back to bus
      expect(deps[0].headsign).toBe("");
      expect(deps[0].platform).toBeUndefined();
    });

    it("returns empty array on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tfl:test", 30);

      expect(deps).toEqual([]);
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getDepartures } = await loadModule();
      const deps = await getDepartures("tfl:test", 30);

      expect(deps).toEqual([]);
    });
  });

  describe("getStops edge cases", () => {
    it("handles stop with no modes", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stopPoints: [{ naptanId: "s1", commonName: "Test", lat: 0, lon: 0 }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops(51.5, -0.1, 500);

      expect(stops).toHaveLength(1);
      expect(stops[0].modes).toEqual(["bus"]); // fallback
    });

    it("handles stop with empty modes array", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stopPoints: [{ naptanId: "s1", commonName: "Test", lat: 0, lon: 0, modes: [] }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops(51.5, -0.1, 500);

      expect(stops).toHaveLength(1);
      expect(stops[0].modes).toEqual(["bus"]);
    });

    it("returns empty array on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const { getStops } = await loadModule();
      const stops = await getStops(51.5, -0.1, 500);

      expect(stops).toEqual([]);
    });

    it("handles stop with name/id fallbacks", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stopPoints: [
            { id: "fallback-id", name: "Fallback Name", lat: 0, lon: 0, modes: ["bus"] },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops(51.5, -0.1, 500);

      expect(stops[0].id).toBe("tfl:fallback-id");
      expect(stops[0].name).toBe("Fallback Name");
    });
  });

  describe("getStop edge cases", () => {
    it("returns null on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const { getStop } = await loadModule();
      const stop = await getStop("tfl:test");

      expect(stop).toBeNull();
    });

    it("returns null on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getStop } = await loadModule();
      const stop = await getStop("tfl:test");

      expect(stop).toBeNull();
    });
  });

  describe("searchByName edge cases", () => {
    it("returns empty array on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const { searchByName } = await loadModule();
      const results = await searchByName("test");

      expect(results).toEqual([]);
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { searchByName } = await loadModule();
      const results = await searchByName("test");

      expect(results).toEqual([]);
    });
  });

  describe("getRouteStopSequence edge cases", () => {
    it("returns empty array without API key", async () => {
      delete process.env.TFL_API_KEY;

      const { getRouteStopSequence } = await loadModule();
      const stops = await getRouteStopSequence("central");

      expect(stops).toEqual([]);
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getRouteStopSequence } = await loadModule();
      const stops = await getRouteStopSequence("central");

      expect(stops).toEqual([]);
    });

    it("returns empty array on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const { getRouteStopSequence } = await loadModule();
      const stops = await getRouteStopSequence("central");

      expect(stops).toEqual([]);
    });
  });

  describe("getStopAlerts edge cases", () => {
    it("returns empty array without API key", async () => {
      delete process.env.TFL_API_KEY;

      const { getStopAlerts } = await loadModule();
      const alerts = await getStopAlerts("tfl:test");

      expect(alerts).toEqual([]);
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getStopAlerts } = await loadModule();
      const alerts = await getStopAlerts("tfl:test");

      expect(alerts).toEqual([]);
    });

    it("returns empty array on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const { getStopAlerts } = await loadModule();
      const alerts = await getStopAlerts("tfl:test");

      expect(alerts).toEqual([]);
    });

    it("returns empty array when response is not an array", async () => {
      mockFetch.mockResolvedValueOnce(mockOk("not-an-array"));

      const { getStopAlerts } = await loadModule();
      const alerts = await getStopAlerts("tfl:test");

      expect(alerts).toEqual([]);
    });

    it("handles disruption with warning severity (default)", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk([
          {
            description: "Some delay",
            category: "SomeCategory",
          },
        ]),
      );

      const { getStopAlerts } = await loadModule();
      const alerts = await getStopAlerts("tfl:test");

      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("warning");
    });
  });

  describe("getRouteAlerts edge cases", () => {
    it("returns empty array without API key", async () => {
      delete process.env.TFL_API_KEY;

      const { getRouteAlerts } = await loadModule();
      const alerts = await getRouteAlerts("tfl:central");

      expect(alerts).toEqual([]);
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getRouteAlerts } = await loadModule();
      const alerts = await getRouteAlerts("tfl:central");

      expect(alerts).toEqual([]);
    });
  });

  describe("getRouteStopSequence", () => {
    it("returns stops in sequence order", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          stopPointSequences: [
            {
              stopPoint: [
                { id: "s1", name: "Stop 1", lat: 51.5, lon: -0.1 },
                { id: "s2", name: "Stop 2", lat: 51.51, lon: -0.11 },
              ],
            },
          ],
        }),
      );

      const { getRouteStopSequence } = await loadModule();
      const stops = await getRouteStopSequence("central");

      expect(stops).toHaveLength(2);
      expect(stops[0].id).toBe("tfl:s1");
      expect(stops[0].sequence).toBe(0);
      expect(stops[1].id).toBe("tfl:s2");
      expect(stops[1].sequence).toBe(1);
    });
  });
});
