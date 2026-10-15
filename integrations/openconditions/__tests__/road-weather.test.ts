import type { BBox } from "@openmapx/core";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { createOpenConditionsClient } from "../client.js";
import type { LatestReading } from "../features/record.js";
import { setup } from "../index.js";
import { recordToRoadWeatherStation } from "../road-weather/map.js";
import { createRoadWeatherProvider } from "../road-weather/provider.js";
import type { LiveSources } from "../sources.js";
import stringsDe from "../strings/de.json" with { type: "json" };
import stringsEn from "../strings/en.json" with { type: "json" };
import featuresResponse from "./fixtures/features-weather.json" with { type: "json" };

/*
 * `features-weather.json` is the `GET /features?kind=weather_station&canonical=1&expand=components,latest`
 * answer for four Digitraffic stations, built from OpenConditions' own parser; see fixtures/README.md.
 */

type Rec = Record<string, unknown>;

const BASE_URL = "http://openconditions.test:4100";
const BBOX: BBox = [24.5, 60.1, 27.5, 63.4];
const NUPURI = "oc:feature:fi-digitraffic-weather:1001";
const VUOSAARI = "oc:feature:fi-digitraffic-weather:1071";
const KOUSA = "oc:feature:fi-digitraffic-weather:7037";
const LAPINLAHTI = "oc:feature:fi-digitraffic-weather:8003";
/** Ten minutes after the stations measured. */
const NOW = new Date("2026-10-14T23:30:00Z");

type Body = { records: Rec[]; latest: Record<string, LatestReading[]> };
const body = () => structuredClone(featuresResponse) as unknown as Body;

const EVERY_SOURCE: LiveSources = {
  ready: true,
  has: () => true,
  link: () => undefined,
  crowd: () => undefined,
  noticeOf: () => undefined,
  firmsSources: () => [],
};

function providerWith(answer: unknown, sources: LiveSources = EVERY_SOURCE, now = NOW) {
  const http = fakeHttpClient((req: FakeHttpRequest) =>
    req.url === `${BASE_URL}/features` ? answer : undefined,
  );
  const client = createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!;
  return { http, provider: createRoadWeatherProvider(client, sources, { now: () => now }) };
}

describe("road-weather-openconditions", () => {
  test("reads the weather stations with the readings of the station and of each sensor", async () => {
    const { http, provider } = providerWith(body());
    const { stations, partial } = await provider.searchStations(BBOX);

    expect(http.calls[0]?.options?.params).toMatchObject({
      bbox: BBOX.join(","),
      kind: "weather_station",
      canonical: 1,
      expand: "components,latest",
      limit: 500,
    });
    expect(partial).toBeUndefined();
    expect(stations.map((s) => s.id)).toEqual([NUPURI, VUOSAARI, KOUSA, LAPINLAHTI]);
    const nupuri = stations[0]!;
    expect(nupuri).toMatchObject({
      name: "Tie 1 Espoo, Nupuri",
      country: "FI",
      coordinates: [24.596399, 60.228227],
      road: "1",
      municipality: "Espoo",
      status: "operational",
      updatedAt: "2026-10-14T23:19:55Z",
      stale: false,
      sources: ["fi-digitraffic-weather"],
    });
    expect(nupuri.air).toMatchObject({
      temperatureC: { value: 9.7, observedAt: "2026-10-14T23:19:55Z" },
      dewPointC: { value: 8.8 },
      humidityPct: { value: 95 },
      visibilityM: { value: 20000 },
      // Wind is the mean of ten minutes, dated by their end.
      windSpeedMs: { value: 0.4, observedAt: "2026-10-14T23:19:55Z" },
      windGustMs: { value: 1.5 },
      windDirectionDeg: { value: 180 },
      precipitation: { value: "none" },
    });
    expect(nupuri.surface.map((s) => s.index)).toEqual([1, 2]);
    expect(nupuri.surface[0]).toMatchObject({
      index: 1,
      state: { value: "dry" },
      temperatureC: { value: 9.6 },
      friction: { value: 0.82 },
    });
    // A dry sensor measures no solution: OpenConditions states no salt or freezing point.
    expect(nupuri.surface[0]).not.toHaveProperty("saltKgM3");
    expect(nupuri.surface[0]).not.toHaveProperty("freezingPointC");
    expect(nupuri).not.toHaveProperty("fault");
    expect(nupuri.attributions).toEqual([
      {
        sourceId: "fi-digitraffic-weather",
        name: "Fintraffic Digitraffic road weather stations",
        url: "https://www.digitraffic.fi/en/",
        licensing: expect.objectContaining({ version: 1 }),
        attributionText: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
      },
    ]);
  });

  test("a sensor slot the station lacks adds no sensor; a salted surface keeps its own state", async () => {
    const { provider } = providerWith(body());
    const { stations } = await provider.searchStations(BBOX);
    expect(stations[0]!.surface.some((s) => s.index > 2)).toBe(false);
    expect(stations[3]!.surface[0]).toMatchObject({
      state: { value: "chemically_wet" },
      saltKgM3: { value: 7.3 },
      freezingPointC: { value: -4.2 },
    });
  });

  test("a closed station stands without values; an hour-old value is no current one", () => {
    const answer = body();
    const vuosaari = recordToRoadWeatherStation(
      answer.records[1]!,
      answer.latest[VUOSAARI]!,
      undefined,
      undefined,
      NOW,
    );
    expect(vuosaari).toMatchObject({ status: "temporarily_closed", stale: true, surface: [] });
    expect(vuosaari?.air).toEqual({});

    const later = recordToRoadWeatherStation(
      answer.records[0]!,
      answer.latest[NUPURI]!,
      undefined,
      undefined,
      new Date("2026-10-15T00:30:00Z"),
    );
    expect(later).toMatchObject({ stale: true, surface: [], updatedAt: "2026-10-14T23:19:55Z" });
    expect(later?.air).toEqual({});
  });

  test("the station's device status: offline is out of service, warning and error a fault", () => {
    const answer = body();
    const station = (id: string, readings = answer.latest[id]!) =>
      recordToRoadWeatherStation(
        answer.records.find((r) => r.id === id)!,
        readings,
        undefined,
        undefined,
        NOW,
      );
    // Kousa's repair was interrupted: a suspected fault, dated by the state's change months ago.
    expect(station(KOUSA)).toMatchObject({
      status: "operational",
      fault: { level: "suspected", since: "2026-08-25T13:14:17Z" },
      // Its values are eight hours old.
      stale: true,
    });
    expect(station(VUOSAARI)?.status).toBe("temporarily_closed");

    const withStatus = (value: string, validUntil?: string) =>
      answer.latest[NUPURI]!.map((r) =>
        r.property === "device.status"
          ? { ...r, result: { ...(r.result as Rec), value }, ...(validUntil ? { validUntil } : {}) }
          : r,
      );
    expect(station(NUPURI, withStatus("error"))).toMatchObject({
      status: "operational",
      fault: { level: "confirmed" },
      stale: false,
    });
    expect(station(NUPURI, withStatus("offline"))?.status).toBe("temporarily_closed");
    // A status past its validity states nothing; the old status is no current value either.
    const expired = station(NUPURI, withStatus("error", "2026-10-14T23:00:00Z"));
    expect(expired).not.toHaveProperty("fault");
    expect(expired?.updatedAt).toBe("2026-10-14T23:19:55Z");
  });

  test("a change-only value past the validity OpenConditions gives it is no current one", () => {
    const answer = body();
    const readings = answer.latest[NUPURI]!.map((r) =>
      r.property === "road.surface_state" ? { ...r, validUntil: "2026-10-14T23:25:00Z" } : r,
    );
    const station = recordToRoadWeatherStation(
      answer.records[0]!,
      readings,
      undefined,
      undefined,
      NOW,
    );
    expect(station?.surface[0]?.state).toBeUndefined();
    expect(station?.surface[0]?.temperatureC).toEqual({
      value: 9.6,
      observedAt: "2026-10-14T23:19:55Z",
    });
  });

  test("a value in another unit than the model's is left out", () => {
    const answer = body();
    const readings = answer.latest[NUPURI]!.map((r) =>
      r.property === "weather.air_temperature"
        ? { ...r, result: { type: "quantity", value: 49.5, unit: "[degF]" } }
        : r,
    );
    const station = recordToRoadWeatherStation(
      answer.records[0]!,
      readings,
      undefined,
      undefined,
      NOW,
    );
    expect(station?.air.temperatureC).toBeUndefined();
  });

  test("serves nothing until the source list arrives, and nothing of a source it does not list", async () => {
    const waiting = providerWith(body(), { ...EVERY_SOURCE, ready: false });
    await expect(waiting.provider.searchStations(BBOX)).resolves.toEqual({
      stations: [],
      partial: "unavailable",
    });
    await expect(waiting.provider.getStation(NUPURI)).resolves.toBeNull();
    const unlisted = providerWith(body(), { ...EVERY_SOURCE, has: () => false });
    await expect(unlisted.provider.searchStations(BBOX)).resolves.toEqual({ stations: [] });
  });

  test("credits the notice a publisher requires beside the feed", async () => {
    const { provider } = providerWith(body(), {
      ...EVERY_SOURCE,
      noticeOf: (id) =>
        id === "fi-digitraffic-weather" ? "Shown with Fintraffic's notice" : undefined,
    });
    const { stations } = await provider.searchStations(BBOX);
    expect(stations[0]!.attributions).toContainEqual({
      sourceId: "fi-digitraffic-weather",
      name: "Shown with Fintraffic's notice",
    });
  });

  test("opens a searched station by reading the box around it", async () => {
    const { http, provider } = providerWith(body());
    await provider.searchStations(BBOX);
    const station = await provider.getStation(LAPINLAHTI);
    expect(station?.id).toBe(LAPINLAHTI);
    const box = String(http.calls[1]?.options?.params?.bbox).split(",").map(Number);
    expect(box[0]).toBeLessThan(27.450941);
    expect(box[2]).toBeGreaterThan(27.450941);
  });

  test("setup registers the road-weather provider; none without OPENCONDITIONS_URL", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, { OPENCONDITIONS_URL: BASE_URL });
    expect(ctx.registered.roadWeather.map((p) => p.id)).toEqual(["road-weather-openconditions"]);

    const bare = createMockIntegrationContext({ id: "openconditions" });
    await setup(bare, {});
    expect(bare.registered.roadWeather).toEqual([]);
  });

  test("the data-flow disclosure names what stations send and receive", () => {
    for (const strings of [stringsEn, stringsDe]) {
      const domain = strings.dataSources["domain:road-weather"];
      expect(domain.purpose).toBeTruthy();
      expect(domain.dataSent).toBeTruthy();
      expect(domain.dataReceived).toBeTruthy();
    }
  });
});
