import type { BBox } from "@openmapx/core";
import type { HazardsProvider } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { createOpenConditionsClient } from "../client.js";
import { pointOf, textOf } from "../hazards/map.js";
import { createHazardsProvider } from "../hazards/provider.js";
import { setup } from "../index.js";
import {
  createLiveSources,
  type LiveSources,
  type OcSource,
  toDataSource,
  type UpdatableLiveSources,
} from "../sources.js";
import stringsDe from "../strings/de.json" with { type: "json" };
import stringsEn from "../strings/en.json" with { type: "json" };
import fire from "./fixtures/observations-fire.json" with { type: "json" };
import grid from "./fixtures/observations-grid.json" with { type: "json" };
import alertsAnswer from "./fixtures/situations-alerts.json" with { type: "json" };
import naturalAnswer from "./fixtures/situations-natural.json" with { type: "json" };
import sourcesAnswer from "./fixtures/sources-hazards.json" with { type: "json" };

/*
 * The fixtures are OpenConditions answers built from the parsers of its
 * `packages/hazards` over their captured feeds; see fixtures/README.md.
 */

type Rec = Record<string, unknown>;

const BASE_URL = "http://openconditions.test:4100";
const OPERATOR = { OPENCONDITIONS_URL: BASE_URL } as NodeJS.ProcessEnv;
const BBOX: BBox = [-180, -90, 180, 90];
const METEOALARM = "eu-meteoalarm-alerts";
const NWS = "us-nws-alerts";
const VIIRS = "nasa-firms-viirs-fires";
const MODIS = "nasa-firms-modis-fires";
const NOTICE =
  "Time delays between this website and the www.meteoalarm.org website are possible. For the most up-to-date awareness information as published by the participating National Meteorological and Hydrological Services, please refer to www.meteoalarm.org.";

const clone = <T>(value: T): T => structuredClone(value);
const ocSources = (): OcSource[] => clone(sourcesAnswer.sources) as unknown as OcSource[];

/** The live list as the integration builds it from a `/sources` answer. */
function liveSources(list: OcSource[] = ocSources()): UpdatableLiveSources {
  const live = createLiveSources();
  live.update(list.flatMap((s) => toDataSource(s) ?? []));
  live.updateDescribed(list);
  live.updateLicenses(list);
  return live;
}

const situationIds = (answer: { records: Rec[] }) => answer.records.map((r) => String(r["id"]));

type Responder = (path: string, params: Record<string, unknown>) => unknown;

function providerWith(responder: Responder, sources: LiveSources = liveSources()) {
  const http = fakeHttpClient((req: FakeHttpRequest) => {
    const path = new URL(req.url).pathname;
    const params = (req.options?.params ?? {}) as Record<string, unknown>;
    return responder(path, params);
  });
  const client = createOpenConditionsClient(OPERATOR, http)!;
  const now = () => new Date("2026-10-09T02:00:00.000Z");
  const provider: HazardsProvider = createHazardsProvider(client, sources, { now });
  return { provider, calls: http.calls };
}

const callParams = (calls: FakeHttpRequest[], i = 0) =>
  (calls[i]?.options?.params ?? {}) as Record<string, unknown>;

/** A keyset-paged answer of `records`, as the API serves a collection. */
function paged(records: Rec[], params: Record<string, unknown>) {
  const limit = Number(params["limit"]);
  const start = params["cursor"] ? Number(params["cursor"]) : 0;
  const page = records.slice(start, start + limit);
  const end = start + page.length;
  return { records: page, next: end < records.length ? String(end) : null };
}

describe("alerts", () => {
  const serve: Responder = (path) => (path === "/situations" ? clone(alertsAnswer) : undefined);

  test("maps the recorded answer; a source's notice goes with its alerts and one without a geometry is dropped", async () => {
    const { provider, calls } = providerWith(serve);
    const result = await provider.getAlerts(BBOX);

    expect(result.partial).toBeUndefined();
    expect(result.alerts.map((a) => a.sources)).toEqual([[METEOALARM], [NWS]]);
    const [austria, juneau] = result.alerts as [
      (typeof result.alerts)[number],
      (typeof result.alerts)[number],
    ];
    expect(austria).toMatchObject({
      id: "oc:situation:eu-meteoalarm-alerts:2.49.0.0.40.0.AT.-20261005084325_ATNT_803",
      groupId: "2.49.0.0.40.0.AT.-20261005083327_ATNT_803",
      type: "thunderstorm",
      event: "Gewitterwarnung",
      headline: "Gewitterwarnung",
      areaDescription: "Dornbirn",
      severity: "Moderate",
      urgency: "future",
      certainty: "likely",
      sent: "2026-10-05T08:43:25+02:00",
      onset: "2026-10-05T08:43:25+02:00",
      expires: "2026-10-05T09:43:25+02:00",
      senderName: "GeoSphere Austria",
      web: "http://warnungen.zamg.at/html/de/heute/Gewitter/at/vorarlberg/",
      notices: [NOTICE],
    });
    expect(austria.geometry.type).toBe("Polygon");
    expect(austria.description).toContain("Gewittern");
    expect(austria.attributions).toEqual([
      expect.objectContaining({
        sourceId: METEOALARM,
        name: "EUMETNET - MeteoAlarm",
        spdxLicense: expect.stringMatching(/MeteoAlarm/),
      }),
    ]);
    expect(juneau).toMatchObject({ severity: "Minor", notices: [] });

    expect(callParams(calls)).toMatchObject({
      bbox: "-180,-90,180,90",
      domain: "hazards",
      kind: "alert",
      limit: 5000,
    });
    expect(callParams(calls)).not.toHaveProperty("simplify");
  });

  test("asks for simplified geometries when the caller does", async () => {
    const { provider, calls } = providerWith(serve);
    await provider.getAlerts(BBOX, { simplifyDeg: 0.01 });
    expect(callParams(calls)).toMatchObject({ simplify: 0.01 });
  });

  test("a disallowed source is left out", async () => {
    const { provider } = providerWith(serve);
    const result = await provider.getAlerts(BBOX, { excludedSourceIds: [METEOALARM] });
    expect(result.alerts.map((a) => a.sources)).toEqual([[NWS]]);
  });

  test("a record of a source the instance does not list is left out", async () => {
    const { provider } = providerWith(
      serve,
      liveSources(ocSources().filter((s) => s.id !== METEOALARM)),
    );
    const result = await provider.getAlerts(BBOX);
    expect(result.alerts.map((a) => a.sources)).toEqual([[NWS]]);
  });

  test("reads pages up to 20,000 situations and says the area is partly covered beyond", async () => {
    const template = (alertsAnswer.records as unknown as Rec[])[0]!;
    const records = Array.from({ length: 25_000 }, (_, i) => ({ ...template, id: `a${i}` }));
    const { provider, calls } = providerWith((path, params) =>
      path === "/situations" ? paged(records, params) : undefined,
    );
    const result = await provider.getAlerts(BBOX);

    expect(calls).toHaveLength(4);
    expect(result.alerts).toHaveLength(20_000);
    expect(result.partial).toBe("area");
    expect(calls[0]!.options?.maxResponseBytes).toBe(64 * 1024 * 1024);
  });

  test("texts come in the requested language, else the first the alert carries", async () => {
    const { provider } = providerWith(serve);
    const english = (await provider.getAlerts(BBOX, { lang: "en-US" })).alerts[0]!;
    expect(english).toMatchObject({
      event: "Thunderstormwarning",
      headline: "Thunderstormwarning",
      areaDescription: "Dornbirn",
      senderName: "GeoSphere Austria",
    });
    expect(english.description).toContain("thunderstorms are possible");
    expect(english.instruction).toContain("BE AWARE");

    const other = (await provider.getAlerts(BBOX, { lang: "fr" })).alerts[0]!;
    expect(other.headline).toBe("Gewitterwarnung");
    expect(other.description).toContain("Gewittern");
  });

  test("a record of another origin passes without being a listed feed; a feed record of an unlisted source does not", async () => {
    const template = (alertsAnswer.records as unknown as Rec[])[0]!;
    const provenance = template["provenance"] as Rec;
    const crowd = {
      ...template,
      id: "crowd-1",
      provenance: { ...provenance, origin: "crowd", sourceId: "crowd" },
    };
    const stray = {
      ...template,
      id: "stray",
      provenance: { ...provenance, sourceId: "x-unlisted" },
    };
    const { provider } = providerWith(() => ({ records: [crowd, stray], next: null }));
    const result = await provider.getAlerts(BBOX);
    expect(result.alerts.map((a) => a.id)).toEqual(["crowd-1"]);
  });

  test("a malformed page fails the read", async () => {
    const { provider } = providerWith(() => ({ records: "nope", next: null }));
    await expect(provider.getAlerts(BBOX)).rejects.toThrow(/Malformed/);
  });
});

describe("natural hazards", () => {
  const serve: Responder = (path) => (path === "/situations" ? clone(naturalAnswer) : undefined);
  const hazards = async () =>
    (await providerWith(serve).provider.getNaturalHazards(BBOX, { types: ["earthquake"] })).hazards;
  const byId = (list: Awaited<ReturnType<typeof hazards>>, id: string) =>
    list.find((h) => h.id === `oc:situation:${id}`)!;

  test("an earthquake carries its depth, tsunami flag and event page", async () => {
    const quake = byId(await hazards(), "usgs-quakes:us6000u0xi");
    expect(quake).toMatchObject({
      type: "earthquake",
      point: [168.1889, -15.5411],
      name: "102 km NE of Norsup, Vanuatu",
      headline: "M 6.3 - 102 km NE of Norsup, Vanuatu",
      magnitude: { value: 6.3, scale: "mww" },
      depthM: 10000,
      tsunamiFlag: false,
      feltReports: 5,
      mmi: 7.654,
      reviewed: true,
      ended: true,
      start: "2026-10-08T09:00:07.768Z",
      detailUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u0xi",
      severity: { label: "minor", declared: "green" },
      sources: ["usgs-quakes"],
    });
    expect(quake.attributions[0]).toMatchObject({
      sourceId: "usgs-quakes",
      name: "U.S. Geological Survey",
    });
    expect(byId(await hazards(), "usgs-quakes:us6000ty43").tsunamiFlag).toBe(true);
  });

  test("a polygon hazard is drawn at the vertex mean of its outer rings", async () => {
    const fire = byId(await hazards(), "us-nifc-fires:DB5448A6-FCAC-4041-A817-6F8198161DBA");
    const record = (naturalAnswer.records as unknown as Rec[]).find((r) =>
      String(r["id"]).endsWith("DB5448A6-FCAC-4041-A817-6F8198161DBA"),
    )!;
    const geometry = (record["location"] as { geometry: GeoJSON.MultiPolygon }).geometry;
    const vertices = geometry.coordinates.flatMap((polygon) => polygon[0]!.slice(0, -1));
    const mean = [
      vertices.reduce((sum, p) => sum + p[0]!, 0) / vertices.length,
      vertices.reduce((sum, p) => sum + p[1]!, 0) / vertices.length,
    ];
    expect(fire.point[0]).toBeCloseTo(mean[0]!, 9);
    expect(fire.point[1]).toBeCloseTo(mean[1]!, 9);
    expect(fire).toMatchObject({
      type: "wildfire",
      subtype: "wildfire_perimeter",
      name: "Tartar",
      areaHa: 63951.39,
      containmentPct: 100,
      ignitionCause: "natural",
      ended: false,
      country: "US",
      region: "US-ID",
    });
    expect(fire.geometry.type).toBe("MultiPolygon");
  });

  test("the vertex mean of a ring leaves out its closing position", () => {
    expect(
      pointOf({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [4, 0],
            [4, 2],
            [0, 2],
            [0, 0],
          ],
        ],
      }),
    ).toEqual([2, 1]);
    expect(pointOf({ type: "Point", coordinates: [7, 8] })).toEqual([7, 8]);
  });

  test("a polygon across the antimeridian is drawn near 180, not near 0", () => {
    const ring = (west: number, east: number): number[][] => [
      [west, 50],
      [east, 50],
      [east, 54],
      [west, 54],
      [west, 50],
    ];
    const east = pointOf({ type: "Polygon", coordinates: [ring(179, -179)] })!;
    expect(Math.abs(east[0])).toBeCloseTo(180, 9);
    expect(east[1]).toBe(52);
    const shifted = pointOf({ type: "Polygon", coordinates: [ring(178, -178)] })!;
    expect(Math.abs(shifted[0])).toBeCloseTo(180, 9);
    const west = pointOf({
      type: "MultiPolygon",
      coordinates: [[ring(179, 180)], [ring(-180, -178)]],
    })!;
    expect(west[0]).toBeCloseTo(-179.75, 9);
    expect(pointOf({ type: "Polygon", coordinates: [] })).toBeNull();
  });

  test("smoke density and detection window, and a volcano's event page", async () => {
    const list = await hazards();
    expect(byId(list, "us-noaa-hms-smoke:2026273-2")).toMatchObject({
      type: "smoke",
      density: "light",
      detection: {
        satellite: "GOES-WEST",
        start: "2026-09-30T12:00:00Z",
        end: "2026-09-30T15:00:00Z",
      },
      ended: false,
    });
    expect(byId(list, "nasa-eonet-events:EONET_20710")).toMatchObject({
      type: "volcano",
      detailUrl: "https://volcano.si.edu/volcano.cfm?vn=357070",
    });
  });

  test("asks by type, subtype and window; a window ends now", async () => {
    const { provider, calls } = providerWith(serve);
    await provider.getNaturalHazards(BBOX, {
      types: ["wildfire", "smoke"],
      subtypes: ["wildfire_perimeter"],
      since: "2026-10-02T02:00:00.000Z",
      simplifyDeg: 0.001,
    });
    expect(callParams(calls)).toMatchObject({
      domain: "hazards",
      kind: "natural_hazard",
      type: "wildfire,smoke",
      subtype: "wildfire_perimeter",
      from: "2026-10-02T02:00:00.000Z",
      to: "2026-10-09T02:00:00.000Z",
      simplify: 0.001,
      limit: 5000,
    });

    await provider.getNaturalHazards(BBOX, { types: ["smoke"] });
    const current = callParams(calls, 1);
    expect(current).not.toHaveProperty("from");
    expect(current).not.toHaveProperty("to");
    expect(current).not.toHaveProperty("subtype");
  });

  test("a hazard of a type the contract does not name is left out", async () => {
    const answer = clone(naturalAnswer) as unknown as { records: Rec[] };
    answer.records[0] = { ...answer.records[0]!, type: "meteor" };
    const { provider } = providerWith(() => answer);
    const result = await provider.getNaturalHazards(BBOX, { types: ["earthquake"] });
    expect(result.hazards).toHaveLength(naturalAnswer.records.length - 1);
  });

  test("names come in the requested language", async () => {
    const answer = clone(naturalAnswer) as unknown as { records: Rec[] };
    const quake = answer.records.find((r) => String(r["id"]).endsWith("us6000u0xi"))!;
    (quake["details"] as Rec)["name"] = [
      { lang: "en", text: "Norsup" },
      { lang: "fr", text: "Norsup (fr)" },
    ];
    const { provider } = providerWith(() => answer);
    const named = async (lang?: string) =>
      (
        await provider.getNaturalHazards(BBOX, { types: ["earthquake"], ...(lang ? { lang } : {}) })
      ).hazards.find((h) => h.id.endsWith("us6000u0xi"))!.name;
    expect(await named("fr-CA")).toBe("Norsup (fr)");
    expect(await named("de")).toBe("Norsup");
    expect(await named()).toBe("Norsup");
  });

  test("no type asks for nothing", async () => {
    const { provider, calls } = providerWith(serve);
    expect(await provider.getNaturalHazards(BBOX, { types: [] })).toEqual({ hazards: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("fire detections", () => {
  /** The `/observations/latest` answer, narrowed by the requested `source` and paged. */
  const serve: Responder = (path, params) => {
    if (path !== "/observations/latest") return undefined;
    const wanted = new Set(String(params["source"]).split(","));
    const records = (fire.records as unknown as Rec[]).filter((r) =>
      wanted.has(String((r["provenance"] as Rec)["sourceId"])),
    );
    return paged(records, params);
  };
  const since = "2026-10-06T02:00:00.000Z";

  test("a VIIRS read keeps only the VIIRS feeds; confidence is a word and the pass a day or night", async () => {
    const { provider, calls } = providerWith(serve);
    const result = await provider.getFirePixels(BBOX, { since, instrument: "viirs", limit: 5000 });

    expect(callParams(calls)).toMatchObject({
      bbox: "-180,-90,180,90",
      property: "fire.frp",
      since,
      source: VIIRS,
      limit: 5000,
    });
    expect(result.partial).toBeUndefined();
    expect(result.pixels).toHaveLength(7);
    expect(result.pixels[0]).toMatchObject({
      point: [12.35023, -0.64101],
      observedAt: "2026-10-07T00:01:00Z",
      frpMW: 0.69,
      brightnessK: 303.36,
      instrument: "viirs",
      satellite: "N21",
      confidence: { level: "nominal" },
      dayNight: "night",
      sources: [VIIRS],
    });
    expect(result.pixels.every((p) => p.instrument === "viirs")).toBe(true);
  });

  test("a MODIS read keeps only the MODIS feed; confidence is a percentage", async () => {
    const { provider, calls } = providerWith(serve);
    const result = await provider.getFirePixels(BBOX, { since, instrument: "modis", limit: 5000 });

    expect(callParams(calls)).toMatchObject({ source: MODIS });
    expect(result.pixels.map((p) => p.confidence)).toEqual([
      { percent: 83 },
      { percent: 20 },
      { percent: 92 },
    ]);
    expect(result.pixels.map((p) => p.dayNight)).toEqual(["night", "night", "day"]);
    expect(result.pixels[2]).toMatchObject({
      frpMW: 101.39,
      instrument: "modis",
      satellite: "T",
      sources: [MODIS],
    });
  });

  test("a read stops at the limit and says the area is partly covered", async () => {
    const { provider, calls } = providerWith(serve);
    const result = await provider.getFirePixels(BBOX, { since, instrument: "viirs", limit: 3 });
    expect(result.pixels).toHaveLength(3);
    expect(result.partial).toBe("area");
    expect(callParams(calls)).toMatchObject({ limit: 3 });
  });

  test("a feed the deployment disallows is not read", async () => {
    const { provider, calls } = providerWith(serve);
    const result = await provider.getFirePixels(BBOX, {
      since,
      instrument: "viirs",
      limit: 5000,
      excludedSourceIds: [VIIRS],
    });
    expect(result).toEqual({ pixels: [] });
    expect(calls).toHaveLength(0);
  });

  test("a reading without a radiated power is left out", async () => {
    const answer = clone(fire) as unknown as { records: Rec[]; next: null };
    answer.records[0] = { ...answer.records[0]!, result: { type: "text", value: "n/a" } };
    const { provider } = providerWith(() => answer);
    const result = await provider.getFirePixels(BBOX, { since, instrument: "viirs", limit: 5000 });
    expect(result.pixels).toHaveLength(9);
  });

  test("density cells carry their count, sum and maximum, and the sources the answer names", async () => {
    const { provider, calls } = providerWith((path) =>
      path === "/observations/grid" ? clone(grid) : undefined,
    );
    const result = await provider.getFireDensity([-30, -60, 60, 70], {
      since,
      instrument: "viirs",
      cellDeg: 1,
    });

    expect(calls).toHaveLength(1);
    expect(callParams(calls)).toEqual({
      property: "fire.frp",
      bbox: "-30,-60,60,70",
      cellDeg: 1,
      since,
      source: VIIRS,
    });
    expect(result.cells).toHaveLength(7);
    expect(result.cells[1]).toEqual({
      point: [11.5, -0.5],
      count: 2,
      frpSumMW: 6.96,
      frpMaxMW: 3.69,
    });
    expect(result.sources).toEqual([MODIS, VIIRS]);
    expect(result.partial).toBeUndefined();
  });

  test("a box of more cells than one grid read takes is read in strips, each cell once", async () => {
    const { provider, calls } = providerWith((path) =>
      path === "/observations/grid" ? clone(grid) : undefined,
    );
    const result = await provider.getFireDensity(BBOX, { since, instrument: "viirs", cellDeg: 1 });

    const strips = calls.map((call) =>
      String((call.options?.params as Record<string, unknown>)["bbox"])
        .split(",")
        .map(Number),
    );
    expect(strips.length).toBeGreaterThan(1);
    for (const [west, south, east, north] of strips) {
      // One-degree cells: a box counts every cell its edges touch.
      const cells =
        (Math.floor(east!) - Math.floor(west!) + 1) * (Math.floor(north!) - Math.floor(south!) + 1);
      expect(cells).toBeLessThanOrEqual(50_000);
    }
    expect(strips[0]![0]).toBe(-180);
    expect(strips.at(-1)![2]).toBe(180);
    for (let i = 1; i < strips.length; i++) expect(strips[i]![0]).toBe(strips[i - 1]![2]);
    // Every strip answered the same cells: each is counted once.
    expect(result.cells).toHaveLength(7);
    expect(result.sources).toEqual([MODIS, VIIRS]);
  });

  test("a source the answer names but the instance does not list is not named", async () => {
    const { provider } = providerWith(
      (path) => (path === "/observations/grid" ? clone(grid) : undefined),
      liveSources(ocSources().filter((s) => s.id !== MODIS)),
    );
    const result = await provider.getFireDensity(BBOX, { since, instrument: "viirs", cellDeg: 1 });
    expect(result.sources).toEqual([VIIRS]);
  });
});

describe("before the first source list", () => {
  const answer: Responder = () => {
    throw new Error("no read expected");
  };
  const none = createLiveSources();

  test("every read is empty and unavailable", async () => {
    const { provider, calls } = providerWith(answer, none);
    const since = "2026-10-06T02:00:00.000Z";
    expect(await provider.getAlerts(BBOX)).toEqual({ alerts: [], partial: "unavailable" });
    expect(await provider.getNaturalHazards(BBOX, { types: ["earthquake"] })).toEqual({
      hazards: [],
      partial: "unavailable",
    });
    expect(await provider.getFirePixels(BBOX, { since, instrument: "viirs", limit: 10 })).toEqual({
      pixels: [],
      partial: "unavailable",
    });
    expect(await provider.getFireDensity(BBOX, { since, instrument: "viirs", cellDeg: 1 })).toEqual(
      {
        cells: [],
        sources: [],
        partial: "unavailable",
      },
    );
    expect(calls).toHaveLength(0);
  });
});

describe("the live source list", () => {
  test("noticeOf names the publisher's notice of a listed source only", () => {
    const live = liveSources();
    expect(live.noticeOf(METEOALARM)).toBe(NOTICE);
    expect(live.noticeOf(NWS)).toBeUndefined();
    expect(liveSources(ocSources().filter((s) => s.id !== METEOALARM)).noticeOf(METEOALARM)).toBe(
      undefined,
    );
  });

  test("firmsSources are the listed FIRMS feeds of an instrument", () => {
    const live = liveSources();
    expect(live.firmsSources("viirs")).toEqual([VIIRS]);
    expect(live.firmsSources("modis")).toEqual([MODIS]);
    const without = liveSources(ocSources().filter((s) => s.id !== VIIRS));
    expect(without.firmsSources("viirs")).toEqual([]);
    expect(createLiveSources().firmsSources("viirs")).toEqual([]);
  });

  test("a feed of another format with a FIRMS qualifier is not a FIRMS feed", () => {
    const list = ocSources().map((s) => (s.id === NWS ? { ...s, qualifier: "firms-viirs" } : s));
    expect(liveSources(list).firmsSources("viirs")).toEqual([VIIRS]);
  });
});

describe("text", () => {
  const value = [
    { lang: "de-DE", text: "Gewitter" },
    { lang: "en-GB", text: "Thunderstorm" },
  ];

  test("takes the request language by its primary subtag, else the first", () => {
    expect(textOf(value, "en")).toBe("Thunderstorm");
    expect(textOf(value, "EN-US")).toBe("Thunderstorm");
    expect(textOf(value, "fr")).toBe("Gewitter");
    expect(textOf(value)).toBe("Gewitter");
    expect(textOf([])).toBeUndefined();
    expect(textOf(undefined)).toBeUndefined();
  });
});

describe("setup and legal disclosure", () => {
  test("setup registers the hazards provider; none without OPENCONDITIONS_URL", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, OPERATOR);
    expect(ctx.registered.hazards.map((p) => p.id)).toEqual(["hazards-openconditions"]);

    const bare = createMockIntegrationContext({ id: "openconditions" });
    await setup(bare, {});
    expect(bare.registered.hazards).toEqual([]);
  });

  test("the hazards domain has its data-flow disclosure in both languages", () => {
    for (const strings of [stringsEn, stringsDe]) {
      const flow = strings.dataSources["domain:hazards"];
      expect(flow.purpose.length).toBeGreaterThan(0);
      expect(flow.dataSent.length).toBeGreaterThan(0);
      expect(flow.dataReceived.length).toBeGreaterThan(0);
    }
  });

  test("the answers in the fixtures name the sources the list carries", () => {
    const ids = new Set(ocSources().map((s) => s.id));
    const named = [...fire.records, ...alertsAnswer.records, ...naturalAnswer.records].map(
      (r) => (r as unknown as { provenance: { sourceId: string } }).provenance.sourceId,
    );
    expect(named.every((id) => ids.has(id))).toBe(true);
    expect(situationIds(alertsAnswer as unknown as { records: Rec[] })).toHaveLength(3);
  });
});
