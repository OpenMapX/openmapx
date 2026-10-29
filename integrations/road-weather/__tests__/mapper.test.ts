import type { DataSourceDetailSection } from "@openmapx/core";
import {
  type I18nToken,
  isI18nToken,
  resolveToken,
  sharedStrings,
} from "@openmapx/integration-framework/strings";
import type { RoadWeatherStation } from "@openmapx/mobility-core/road-weather";
import { describe, expect, it } from "vitest";
import { mapStationToDetail, mapStationToResult, variantOf } from "../mapper.js";
import de from "../strings/de.json";
import en from "../strings/en.json";

const AT = "2026-10-14T23:19:55Z";

function text(t: unknown, locale = "en"): string {
  if (!isI18nToken(t)) return String(t);
  return resolveToken(t, {
    locale,
    fallbackLocale: "en",
    shared: sharedStrings,
    integration: { en, de },
  });
}

function rows(section: DataSourceDetailSection | undefined, locale = "en"): string[][] {
  return (section?.rows ?? []).map((row) => row.map((cell) => text(cell, locale)));
}

function station(over: Partial<RoadWeatherStation> = {}): RoadWeatherStation {
  return {
    id: "oc:feature:fi-digitraffic-weather:1001",
    name: "Tie 1 Espoo, Nupuri",
    country: "FI",
    coordinates: [24.596399, 60.228227],
    road: "1",
    municipality: "Espoo",
    status: "operational",
    air: {
      temperatureC: { value: 0.4, observedAt: AT },
      dewPointC: { value: -1.2, observedAt: AT },
      humidityPct: { value: 95, observedAt: AT },
      visibilityM: { value: 20000, observedAt: AT },
      windSpeedMs: { value: 3.1, observedAt: AT },
      windGustMs: { value: 5.6, observedAt: AT },
      windDirectionDeg: { value: 192, observedAt: AT },
      precipitation: { value: "snow", observedAt: AT },
      precipitationMmH: { value: 0.6, observedAt: AT },
    },
    surface: [
      {
        index: 1,
        state: { value: "wet", observedAt: AT },
        temperatureC: { value: 0.3, observedAt: AT },
        freezingPointC: { value: -4.2, observedAt: AT },
        friction: { value: 0.62, observedAt: AT },
        waterFilmMm: { value: 0.29, observedAt: AT },
      },
      {
        index: 2,
        state: { value: "black_ice", observedAt: AT },
        temperatureC: { value: -1.5, observedAt: AT },
      },
    ],
    updatedAt: AT,
    stale: false,
    sources: ["fi-digitraffic-weather"],
    attributions: [
      { sourceId: "fi-digitraffic-weather", name: "Fintraffic Digitraffic road weather stations" },
    ],
    ...over,
  };
}

describe("mapStationToResult", () => {
  it("colours a station by its most hazardous surface and sums up the road and the air", () => {
    const result = mapStationToResult(station());
    expect(result).toMatchObject({
      id: "oc:feature:fi-digitraffic-weather:1001",
      source: "fi-digitraffic-weather",
      variant: "icy",
      status: "operational",
      observedAt: AT,
      sortValues: { roadTemperature: -1.5 },
    });
    expect(text(result.summary)).toBe("Black ice · Road -1.5 °C · Air 0.4 °C");
    expect(text(result.summary, "de")).toBe("Glatteis · Fahrbahn -1,5 °C · Luft 0,4 °C");
  });

  it("ranks ice over snow over wet over dry", () => {
    const sensor = (value: RoadWeatherStation["surface"][number]["state"]) => ({
      index: 1,
      state: value,
    });
    const of = (...states: string[]) =>
      variantOf(
        station({
          surface: states.map((s, i) => ({
            ...sensor({ value: s as never }),
            index: i + 1,
          })),
        }),
      );
    expect(of("dry", "slush")).toBe("snowy");
    expect(of("chemically_wet", "dry")).toBe("wet");
    expect(of("dry")).toBe("dry");
    expect(of("frost", "packed_snow")).toBe("icy");
    expect(of("unknown")).toBe("unknown");
    expect(of()).toBe("unknown");
  });

  it("dims a station out of service or without current values, and says why", () => {
    const closed = mapStationToResult(station({ status: "temporarily_closed" }));
    expect(closed).toMatchObject({ variant: "unknown", status: "non-operational" });
    expect(closed.sortValues).toBeUndefined();
    expect(text(closed.summary)).toBe("Out of service");
    const silent = mapStationToResult(station({ stale: true, air: {}, surface: [] }));
    expect(silent).toMatchObject({ variant: "unknown", status: "non-operational" });
    expect(text(silent.summary, "de")).toBe("Keine aktuellen Messwerte");
  });

  it("states only what it measures", () => {
    const air = mapStationToResult(station({ surface: [] }));
    expect(text(air.summary)).toBe("Air 0.4 °C");
    const surface = mapStationToResult(station({ air: {} }));
    expect(text(surface.summary)).toBe("Black ice · Road -1.5 °C");
    const optical = mapStationToResult(
      station({ air: {}, surface: [{ index: 1, friction: { value: 0.82, observedAt: AT } }] }),
    );
    expect(text(optical.summary, "de")).toBe("Griffigkeit 0,82");
    expect(text(mapStationToResult(station({ air: {}, surface: [] })).summary)).toBe("No values");
  });

  it("names a station its sources leave unnamed", () => {
    expect(text(mapStationToResult(station({ name: "" })).fallbackName)).toBe(
      "Road weather station",
    );
  });
});

describe("mapStationToDetail", () => {
  it("lists each surface sensor, the weather and the station's place", () => {
    const detail = mapStationToDetail(station());
    expect(detail.sections.map((s) => text(s.title))).toEqual([
      "Road surface, sensor 1",
      "Road surface, sensor 2",
      "Weather",
      "Info",
    ]);
    expect(rows(detail.sections[0])).toEqual([
      ["Surface", "Wet"],
      ["Road temperature", "0.3 °C"],
      ["Freezing point", "-4.2 °C"],
      ["Grip", "0.62"],
      ["Water", "0.29 mm"],
    ]);
    expect(detail.sections[0]).toMatchObject({ captionTimestamp: AT });
    expect(text(detail.sections[0]?.caption)).toBe("Measured");
    expect(rows(detail.sections[2])).toEqual([
      ["Air temperature", "0.4 °C"],
      ["Dew point", "-1.2 °C"],
      ["Humidity", "95%"],
      ["Wind", "3.1 m/s from the south"],
      ["Gusts", "5.6 m/s"],
      ["Visibility", "20 km"],
      ["Precipitation", "Snow, 0.6 mm/h"],
    ]);
    expect(rows(detail.sections[2], "de")).toContainEqual(["Wind", "3,1 m/s aus Süd"]);
    expect(rows(detail.sections[3])).toEqual([
      ["Road", "1"],
      ["Municipality", "Espoo"],
      ["Provider", "Fintraffic Digitraffic road weather stations"],
    ]);
    expect(detail.attributions).toEqual([
      { sourceId: "fi-digitraffic-weather", name: "Fintraffic Digitraffic road weather stations" },
    ]);
  });

  it("notes a fault above the values it still shows, and states it in the summary", () => {
    const since = "2026-08-25T13:14:17Z";
    const suspected = station({ fault: { level: "suspected", since } });
    const detail = mapStationToDetail(suspected);
    expect(detail.sections.map((s) => text(s.title))).toEqual([
      "Station status",
      "Road surface, sensor 1",
      "Road surface, sensor 2",
      "Weather",
      "Info",
    ]);
    expect(detail.sections[0]).toMatchObject({
      type: "text",
      sectionIcon: "warning",
      captionTimestamp: since,
    });
    expect(text(detail.sections[0]?.content as I18nToken)).toMatch(/suspects a fault/);
    const result = mapStationToResult(suspected);
    expect(result).toMatchObject({ variant: "icy", status: "operational" });
    expect(text(result.summary)).toBe("Black ice · Road -1.5 °C · Air 0.4 °C · Fault suspected");
    expect(
      text(mapStationToResult(station({ fault: { level: "confirmed" } })).summary, "de"),
    ).toMatch(/· Störung bestätigt$/);
    // Out of service says so alone.
    const closed = station({ status: "temporarily_closed", fault: { level: "confirmed" } });
    expect(text(mapStationToResult(closed).summary)).toBe("Out of service");
    expect(mapStationToDetail(closed).sections.map((s) => text(s.title))).toEqual([
      "Readings",
      "Info",
    ]);
  });

  it("shows a dry sensor without salt or freezing point cleanly", () => {
    const detail = mapStationToDetail(
      station({
        surface: [
          {
            index: 1,
            state: { value: "dry", observedAt: AT },
            temperatureC: { value: 9.6, observedAt: AT },
          },
        ],
      }),
    );
    expect(rows(detail.sections[0])).toEqual([
      ["Surface", "Dry"],
      ["Road temperature", "9.6 °C"],
    ]);
  });

  it("titles a single sensor's section the road surface", () => {
    const detail = mapStationToDetail(station({ surface: [station().surface[0]!] }));
    expect(text(detail.sections[0]?.title, "de")).toBe("Fahrbahn");
  });

  it("explains a silent station with the time of its last reading", () => {
    const detail = mapStationToDetail(station({ stale: true, air: {}, surface: [] }));
    expect(detail.sections[0]).toMatchObject({ type: "text", captionTimestamp: AT });
    expect(text(detail.sections[0]?.content as I18nToken)).toBe(
      "The station has reported no current readings.",
    );
    const closed = mapStationToDetail(
      station({ status: "temporarily_closed", updatedAt: undefined }),
    );
    expect(text(closed.sections[0]?.content as I18nToken, "de")).toBe(
      "Die Station ist vorübergehend außer Betrieb.",
    );
    expect(closed.sections[0]?.captionTimestamp).toBeUndefined();
  });

  it("every state and precipitation type has its label in both languages", () => {
    for (const strings of [en, de]) {
      expect(Object.keys(strings.state)).toEqual(Object.keys(en.state));
      expect(Object.keys(strings.precipitation)).toEqual(Object.keys(en.precipitation));
    }
  });
});
