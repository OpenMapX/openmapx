import type { HazardsProvider, NaturalHazard } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hazardToFeature, setup } from "./index.js";

function hazard(over: Partial<NaturalHazard> = {}): NaturalHazard {
  return {
    id: "oc:situation:gdacs-events:TC_1001234",
    type: "tropical_cyclone",
    geometry: { type: "Point", coordinates: [130.2, 18.4] },
    point: [130.2, 18.4],
    name: "Tropical Cyclone MAWAR-26",
    start: "2026-10-05T00:00:00Z",
    ended: false,
    severity: { label: "major", declared: "Orange" },
    maxWindKmh: 185,
    detailUrl: "https://www.gdacs.org/report.aspx?eventtype=TC&eventid=1001234",
    sources: ["gdacs-events"],
    attributions: [],
    ...over,
  };
}

const FLOOD_POLYGON: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [30, -2],
      [31, -2],
      [31, -1],
      [30, -1],
      [30, -2],
    ],
  ],
};

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type EventsBody = {
  sources: string[];
  features: Array<{
    id?: string;
    geometry: { type: string; coordinates: number[] };
    properties: Record<string, unknown>;
  }>;
};

function provider(over: Partial<HazardsProvider> = {}): HazardsProvider {
  return {
    id: "hazards-test",
    coverage: { all: true },
    getAlerts: async () => ({ alerts: [] }),
    getNaturalHazards: async () => ({ hazards: [] }),
    getFirePixels: async () => ({ pixels: [] }),
    getFireDensity: async () => ({ cells: [], sources: [] }),
    ...over,
  };
}

async function callEvents(
  providers: HazardsProvider[],
  query: Record<string, string> = {},
  cache?: ReturnType<typeof createMockIntegrationContext>["cache"],
) {
  const base = createMockIntegrationContext(cache ? { cache } : {});
  const ctx = {
    ...base,
    getIntegrationsByDomain: (domain: string) =>
      domain === "hazards"
        ? providers.map((p) => ({ id: p.id, providers: new Map([["hazards", [p]]]) }))
        : [],
  } as unknown as Parameters<typeof setup>[0];
  setup(ctx);
  const route = base.registered.routes.find((r) => r.path === "/events");
  if (!route) throw new Error("no /events route");

  const sent: Sent = { status: 200, headers: {}, body: undefined };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    header(name: string, value: string) {
      sent.headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  await route.handler({ query, params: {}, headers: {} } as never, reply as never);
  return sent;
}

describe("hazardToFeature", () => {
  it("maps a GDACS orange tropical cyclone to a severe storm with an orange alert", () => {
    expect(hazardToFeature(hazard())).toEqual({
      type: "Feature",
      id: "oc:situation:gdacs-events:TC_1001234",
      geometry: { type: "Point", coordinates: [130.2, 18.4] },
      properties: {
        id: "oc:situation:gdacs-events:TC_1001234",
        title: "Tropical Cyclone MAWAR-26",
        categoryId: "severeStorms",
        categoryTitle: "Tropical Cyclones",
        date: "2026-10-05T00:00:00Z",
        updated: "2026-10-05T00:00:00Z",
        closed: null,
        magnitudeLabel: "185 km/h",
        alertLevel: "orange",
        link: "https://www.gdacs.org/report.aspx?eventtype=TC&eventid=1001234",
        sourceUrl: "https://www.gdacs.org/report.aspx?eventtype=TC&eventid=1001234",
        source: "gdacs-events",
        sources: ["gdacs-events"],
      },
    });
  });

  it("draws a polygon flood as one point at its representative position", () => {
    const feature = hazardToFeature(
      hazard({
        id: "oc:situation:nasa-eonet-events:EONET_1",
        type: "flood",
        geometry: FLOOD_POLYGON,
        point: [30.5, -1.5],
        name: "Floods in Burundi",
        severity: undefined,
        maxWindKmh: undefined,
        areaHa: 12500.4,
        sources: ["nasa-eonet-events"],
      }),
    );
    expect(feature?.geometry).toEqual({ type: "Point", coordinates: [30.5, -1.5] });
    expect(feature?.properties).toMatchObject({
      categoryId: "floods",
      magnitudeLabel: "12500 ha",
      alertLevel: null,
      source: "nasa-eonet-events",
    });
  });

  it("closes an ended hazard at its end and keeps an alert level only when GDACS-coloured", () => {
    const feature = hazardToFeature(
      hazard({ ended: true, end: "2026-10-07T12:00:00Z", severity: { label: "unknown" } }),
    );
    expect(feature?.properties).toMatchObject({ closed: "2026-10-07T12:00:00Z", alertLevel: null });
    expect(
      hazardToFeature(hazard({ severity: { label: "moderate", declared: "Yellow" } }))?.properties
        .alertLevel,
    ).toBeNull();
  });

  it("leaves out a hazard of a type no category shows", () => {
    expect(hazardToFeature(hazard({ type: "earthquake" }))).toBeNull();
  });
});

describe("GET /events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const ALL_TYPES = [
    "volcano",
    "tropical_cyclone",
    "flood",
    "landslide",
    "sea_ice",
    "drought",
    "dust_storm",
  ];

  it("reads the current hazards of every category from the world for status=open, simplified", async () => {
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [hazard()],
    }));
    const sent = await callEvents([provider({ getNaturalHazards })], { lang: "de-DE" });

    expect(getNaturalHazards).toHaveBeenCalledWith([-180, -90, 180, 90], {
      types: ALL_TYPES,
      simplifyDeg: 0.05,
      lang: "de",
    });
    expect(sent.status).toBe(200);
    expect(sent.headers["Cache-Control"]).toBe("public, max-age=900");
    const body = sent.body as EventsBody;
    expect(body.sources).toEqual(["gdacs-events"]);
    expect(body.features).toHaveLength(1);
  });

  it("status=open&days=30 keeps the open hazards updated within the days, never an ended one", async () => {
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [
        hazard({ id: "recent", start: "2026-10-05T00:00:00Z" }),
        // A volcano open for years, last updated this week.
        hazard({
          id: "long-open",
          type: "volcano",
          start: "2019-01-01T00:00:00Z",
          updatedAt: "2026-10-08T00:00:00Z",
          sources: ["nasa-eonet-events"],
        }),
        hazard({ id: "quiet", start: "2026-08-01T00:00:00Z", updatedAt: "2026-08-15T00:00:00Z" }),
        hazard({ id: "ended", ended: true, end: "2026-10-07T00:00:00Z" }),
      ],
    }));
    const sent = await callEvents([provider({ getNaturalHazards })], {
      status: "open",
      days: "30",
    });

    // The open read is the current hazards: no window read.
    expect(getNaturalHazards.mock.calls[0]?.[1].since).toBeUndefined();
    const body = sent.body as EventsBody;
    expect(body.features.map((f) => f.id)).toEqual(["recent", "long-open"]);
    expect(body.sources).toEqual(["gdacs-events", "nasa-eonet-events"]);
  });

  it("status=open without days keeps every open hazard and drops the ended", async () => {
    const getNaturalHazards = async () => ({
      hazards: [hazard({ id: "open" }), hazard({ id: "ended", ended: true })],
    });
    const sent = await callEvents([provider({ getNaturalHazards })]);
    expect((sent.body as EventsBody).features.map((f) => f.id)).toEqual(["open"]);
  });

  it("reads a window only for closed and all: `days` days back, a year without", async () => {
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [],
    }));
    await callEvents([provider({ getNaturalHazards })], { status: "closed", days: "30" });
    await callEvents([provider({ getNaturalHazards })], { status: "all" });
    expect(getNaturalHazards.mock.calls.map((call) => call[1].since)).toEqual([
      "2026-09-09T12:00:00.000Z",
      "2025-10-09T12:00:00.000Z",
    ]);
  });

  it("keeps only ended hazards for status=closed", async () => {
    const getNaturalHazards = async () => ({
      hazards: [
        hazard({ id: "open" }),
        hazard({ id: "ended", ended: true, end: "2026-10-01T00:00:00Z" }),
      ],
    });
    const sent = await callEvents([provider({ getNaturalHazards })], {
      status: "closed",
      days: "30",
    });
    expect((sent.body as EventsBody).features.map((f) => f.id)).toEqual(["ended"]);
  });

  it("reads every category and serves only the requested ones, credits from what it serves", async () => {
    const getNaturalHazards = vi.fn<HazardsProvider["getNaturalHazards"]>(async () => ({
      hazards: [
        hazard({ id: "storm" }),
        hazard({ id: "volcano", type: "volcano", sources: ["nasa-eonet-events"] }),
      ],
    }));
    const sent = await callEvents([provider({ getNaturalHazards })], {
      category: "floods,volcanoes",
    });
    expect(getNaturalHazards.mock.calls[0]?.[1].types).toEqual(ALL_TYPES);
    const body = sent.body as EventsBody;
    expect(body.features.map((f) => f.id)).toEqual(["volcano"]);
    expect(body.sources).toEqual(["nasa-eonet-events"]);
  });

  it("rejects an unknown status or category, and any day limit the legend does not offer", async () => {
    expect((await callEvents([provider()], { status: "pending" })).status).toBe(400);
    expect((await callEvents([provider()], { category: "snow" })).status).toBe(400);
    for (const days of ["0", "1", "29", "31", "366", "ten"]) {
      expect((await callEvents([provider()], { days })).status).toBe(400);
    }
    for (const days of ["30", "90", "365"]) {
      expect((await callEvents([provider()], { days })).status).toBe(200);
    }
  });

  it("caches one entry per status, window and language, whatever the categories and open day limit", async () => {
    const keys: string[] = [];
    const cache = {
      ...createMockIntegrationContext().cache,
      withCache: async <T>(key: string, _ttl: number, fn: () => Promise<T>) => {
        keys.push(key);
        return fn();
      },
    };
    await callEvents([provider()], { category: "floods,volcanoes" }, cache);
    await callEvents([provider()], { category: "drought" }, cache);
    await callEvents([provider()], { days: "30" }, cache);
    await callEvents([provider()], { days: "365" }, cache);
    await callEvents([provider()], { lang: "fr" }, cache);
    await callEvents([provider()], { lang: "en-GB" }, cache);
    expect(new Set(keys).size).toBe(1);
    await callEvents([provider()], { status: "closed", days: "30" }, cache);
    await callEvents([provider()], { status: "closed", days: "90" }, cache);
    expect(new Set(keys).size).toBe(3);
  });

  it("answers 503 when every provider failed", async () => {
    const getNaturalHazards = async () => {
      throw new Error("upstream down");
    };
    const sent = await callEvents([provider({ getNaturalHazards })]);
    expect(sent.status).toBe(503);
    expect(sent.headers["Cache-Control"]).toBe("no-store");
  });

  it("answers 503 when no hazards provider is configured: no source is not no events", async () => {
    const sent = await callEvents([]);
    expect(sent.status).toBe(503);
    expect(sent.headers["Cache-Control"]).toBe("no-store");
  });
});
