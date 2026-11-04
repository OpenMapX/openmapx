import type { Place, TidesPayload } from "@openmapx/core";
import { getPlaceResolver } from "@openmapx/place-ids";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup as canada } from "../../../integrations/knowledge-tides-canada/index";
import { setup as ioc } from "../../../integrations/knowledge-tides-ioc/index";
import { setup as norway } from "../../../integrations/knowledge-tides-norway/index";
import { setup as pegel } from "../../../integrations/knowledge-tides-pegelonline/index";
import { createMockIntegrationContext } from "./testing";
import { createTidesIntegration } from "./tides-integration-factory";

function host() {
  const ctx = createMockIntegrationContext();
  const values = new Map<string, unknown>();
  // Deliberately return references: consumers must not mutate retained cache objects.
  ctx.cache.get = async <T>(key: string) => (values.get(key) as T) ?? null;
  ctx.cache.set = async (key, value) => {
    values.set(key, structuredClone(value));
  };
  let terms = "Acquired terms";
  Object.defineProperty(ctx, "attributionIndex", {
    value: {
      getById: (sourceId: string) => ({ sourceId, name: terms, attributionText: terms }),
    } as typeof ctx.attributionIndex,
  });
  const read = async (query: Record<string, string>) => {
    let body: unknown;
    const reply = {
      header: () => {},
      status: () => reply,
      send: (value: unknown) => {
        body = value;
      },
      type: () => {},
    };
    const route = ctx.registered.routes.find((r) => r.path === "/tides");
    if (!route) throw new Error("missing tides route");
    await route.handler({ params: {}, headers: {}, body: null, query }, reply);
    return body as TidesPayload;
  };
  return {
    ctx,
    values,
    read,
    terms: (value: string) => {
      terms = value;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  { contributors: undefined },
  { contributors: [] },
  { contributors: [{ sourceId: "native", name: "Native terms" }] },
])("does not replace native tide capture %j", async ({ contributors }) => {
  const { ctx, read } = host();
  createTidesIntegration(ctx, {
    scheme: "test-receipts",
    sourceId: "wrapper",
    loadStations: async () => [{ lat: 54, lng: 10 }],
    findStationById: (stations) => stations[0],
    createPlace: () => null,
    buildTidesResponse: async () => ({
      station: { id: "s", name: "S", lat: 54, lng: 10, distanceKm: 0 },
      events: [],
      curve: [],
      datum: "MLLW",
      units: "english",
      timeZone: "lst_ldt",
      heightSource: "prediction",
      contributors,
    }),
    maxStationDistanceKm: 10,
    nearestCacheTtl: 60,
    cacheControlMaxAge: 60,
    unavailableMessage: "empty",
  });
  expect((await read({ station: "s" })).contributors).toEqual(contributors);
  expect((await read({ lat: "54", lng: "10" })).contributors).toEqual(contributors);
});

const cases = [
  {
    name: "Norway",
    setup: norway,
    id: "s",
    sourceId: "kartverket-sehavniva",
    datum: "chart_datum",
    timeZone: "iso_offset",
    heightSource: "prediction",
    catalog: '<location name="Station" code="s" latitude="54" longitude="10" type="PERM"/>',
    data: '<waterlevel value="100" time="2026-10-15T12:00:00Z" flag="pre"/><waterlevel value="100" time="2026-10-15T12:00:00Z" flag="high"/>',
  },
  {
    name: "Canada",
    setup: canada,
    id: "s",
    sourceId: "dfo-iwls",
    datum: "chart_datum",
    timeZone: "iso_offset",
    heightSource: "prediction",
    catalog: [
      {
        id: "s",
        code: "s",
        officialName: "Station",
        latitude: 54,
        longitude: 10,
        operating: true,
        timeSeries: [{ code: "wlp" }, { code: "wlo" }],
      },
    ],
    data: [
      { eventDate: "2026-10-15T12:00:00Z", value: 1 },
      { eventDate: "2026-10-15T12:30:00Z", value: 1.1 },
    ],
  },
  {
    name: "IOC",
    setup: ioc,
    id: "s",
    sourceId: "ioc-sealevel",
    datum: "sensor_reference",
    timeZone: "iso_offset",
    heightSource: "observation",
    catalog: [{ Code: "s", Location: "Station", Lat: 54, Lon: 10, status: 1 }],
    data: [
      { slevel: 1, stime: "2026-10-15 12:00:00", sensor: "rad" },
      { slevel: 1.1, stime: "2026-10-15 12:30:00", sensor: "rad" },
    ],
  },
  {
    name: "Pegelonline",
    setup: pegel,
    id: "s",
    sourceId: "wsv-pegelonline",
    datum: "gauge_zero",
    timeZone: "iso_offset",
    heightSource: "observation",
    catalog: [{ uuid: "s", shortname: "Station", latitude: 54, longitude: 10 }],
    data: [{ timestamp: "2026-10-15T12:00:00Z", value: 100 }],
  },
];

describe.each(cases)("$name acquisition", (adapter) => {
  it("names the reference its heights are measured from and its timestamp form", async () => {
    const h = host();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      const isCatalog =
        url.includes("stationlist") || url.includes("/stations?") || url.includes("/stations.json");
      const value = isCatalog ? adapter.catalog : adapter.data;
      return new Response(typeof value === "string" ? value : JSON.stringify(value), {
        status: 200,
      });
    });
    adapter.setup(h.ctx);
    const direct = await h.read({ station: adapter.id });
    const nearest = await h.read({ lat: "54", lng: "10" });
    for (const payload of [direct, nearest]) {
      expect(payload.datum).toBe(adapter.datum);
      expect(payload.timeZone).toBe(adapter.timeZone);
      expect(payload.heightSource).toBe(adapter.heightSource);
      for (const event of payload.events) expect(event.time).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
    }
  });

  it("rebuilds coordinate lookups cached before heights named their source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const h = host();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      const isCatalog =
        url.includes("stationlist") || url.includes("/stations?") || url.includes("/stations.json");
      const value = isCatalog ? adapter.catalog : adapter.data;
      return new Response(typeof value === "string" ? value : JSON.stringify(value), {
        status: 200,
      });
    });
    for (const generation of ["datum-v1", "sea-level-sensor-v1"]) {
      h.values.set(`nearest:${generation}:54,10:2026-10-15`, { datum: adapter.datum });
    }
    adapter.setup(h.ctx);

    const nearest = await h.read({ lat: "54", lng: "10" });

    expect(nearest.heightSource).toBe(adapter.heightSource);
  });

  it("retains old inner-cache capture for direct station and a fresh coordinate key", async () => {
    const h = host();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      const isCatalog =
        url.includes("stationlist") || url.includes("/stations?") || url.includes("/stations.json");
      if (!isCatalog) h.terms("Changed during acquisition");
      const value = isCatalog ? adapter.catalog : adapter.data;
      return new Response(typeof value === "string" ? value : JSON.stringify(value), {
        status: 200,
      });
    });
    adapter.setup(h.ctx);
    const first = await h.read({ station: adapter.id });
    h.terms("New terms");
    const direct = await h.read({ station: adapter.id });
    const nearest = await h.read({ lat: "54.0001", lng: "10" });
    expect(first.fieldContributors?.events).toEqual([
      { sourceId: adapter.sourceId, name: "Acquired terms", attributionText: "Acquired terms" },
    ]);
    expect(first.contributors?.map((receipt) => receipt.name)).toEqual(
      adapter.name === "Canada"
        ? ["Acquired terms", "Changed during acquisition"]
        : ["Acquired terms"],
    );
    expect(direct.contributors).toEqual(first.contributors);
    expect(nearest.contributors).toEqual(first.contributors);
    // Refresh the prediction generation while retaining the older catalog.
    for (const key of h.values.keys()) if (key.startsWith("tides:")) h.values.delete(key);
    h.terms("Replacement predictions");
    const replaced = await h.read({ station: adapter.id });
    expect(replaced.fieldContributors?.station?.[0].name).toBe("Acquired terms");
    expect(replaced.fieldContributors?.events?.[0].name).toBe("Replacement predictions");
    const scheme = { Norway: "kartverket", Canada: "ca-iwls", IOC: "ioc", Pegelonline: "pegel" }[
      adapter.name
    ]!;
    const resolved = await getPlaceResolver<Place>(scheme)!(adapter.id, {});
    expect(resolved?.contributors?.map((receipt) => receipt.name)).toEqual(["Acquired terms"]);
  });
});

it("rebuilds IOC levels cached before sea-level sensor selection, in metres", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
  const h = host();
  // Abashiri: the station list names the JMA originator's feet, but the data
  // endpoint serves metres on a 0.01 ft grid (467 * 0.003048 m).
  const catalog = [
    { Code: "abas", Location: "Abashiri", Lat: 54, Lon: 10, status: 1, sensor: "rad", units: "F" },
  ];
  const data = [
    { slevel: 0, stime: "2026-10-31 11:58:00", sensor: "bat" },
    { slevel: 0, stime: "2026-10-31 11:59:00", sensor: "bat" },
    { slevel: 1.4234, stime: "2026-10-31 11:58:00", sensor: "rad" },
    { slevel: 1.4112, stime: "2026-10-31 11:59:00", sensor: "rad" },
  ];
  vi.stubGlobal("fetch", async (input: string | URL | Request) =>
    Response.json(String(input).includes("stationlist") ? catalog : data),
  );
  h.values.set("nearest:datum-v1:54,10:2026-10-31", { currentLevel: { valueFt: 0 } });
  h.values.set("tides:datum-v1:abas:2026-10-31T12", { currentLevel: { valueFt: 0 } });
  ioc(h.ctx);

  const nearest = await h.read({ lat: "54", lng: "10" });
  const direct = await h.read({ station: "abas" });

  for (const payload of [nearest, direct]) {
    expect(payload.currentLevel?.valueFt).toBe(4.63);
    expect(payload.curve.map((point) => point.valueFt)).toEqual([4.67, 4.63]);
  }
});

it("refreshes Canadian current-level ownership without relabelling predictions or mutating caches", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  const h = host();
  const adapter = cases[1];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    return new Response(
      JSON.stringify(url.includes("/stations?") ? adapter.catalog : adapter.data),
      { status: 200 },
    );
  });
  canada(h.ctx);
  await h.read({ lat: "54", lng: "10" });
  const predictionCaches = () =>
    [...h.values.entries()].filter(
      ([key]) => key.startsWith("tides:") || key.startsWith("nearest:"),
    );
  const retained = structuredClone(predictionCaches());
  for (const key of h.values.keys()) if (key.startsWith("obs:")) h.values.delete(key);
  h.terms("Fresh observation terms");
  const refreshed = await h.read({ lat: "54", lng: "10" });
  expect(refreshed.fieldContributors?.events?.[0].name).toBe("Acquired terms");
  expect(refreshed.fieldContributors?.currentLevel?.[0].name).toBe("Fresh observation terms");
  expect(refreshed.contributors?.map((receipt) => receipt.name)).toEqual([
    "Acquired terms",
    "Fresh observation terms",
  ]);
  expect(predictionCaches()).toEqual(retained);
});
