import { describe, expect, it } from "vitest";
import {
  buildStationDetail,
  stopPlaceToAutocompleteResult,
  stopPlaceToPlace,
  stopPlaceToSearchResult,
} from "./stations-mapper.js";
import type { RisStopPlace } from "./stations-types.js";

const STOP: RisStopPlace = {
  evaNumber: "8000207",
  names: { DE: { nameLong: "Köln Hbf" }, EN: { nameLong: "Cologne Central" } },
  metropolis: { DE: "Köln", EN: "Cologne" },
  position: { longitude: 6.9589, latitude: 50.9431 },
  availableTransports: [{ type: "REGIONAL_TRAIN" }, { type: "TRAM" }, { type: "TRAM" }],
};

describe("stopPlaceToSearchResult", () => {
  it("includes the city in the label and prefers the requested language", () => {
    expect(stopPlaceToSearchResult(STOP, "en")).toEqual({
      id: "eva:8000207",
      label: "Cologne Central, Cologne",
      coordinates: [6.9589, 50.9431],
      type: "poi",
      confidence: 1,
      rawCategory: "railway/station",
    });
  });

  it("falls back to the German name and omits the city when absent", () => {
    const result = stopPlaceToSearchResult({
      evaNumber: "1",
      names: { DE: { nameLong: "Bahnhof" } },
      position: { longitude: 1, latitude: 2 },
    });
    expect(result.label).toBe("Bahnhof");
  });

  it("falls back to the EVA number when there is no name at all", () => {
    const result = stopPlaceToSearchResult({
      evaNumber: "42",
      names: {},
      position: { longitude: 1, latitude: 2 },
    });
    expect(result.label).toBe("EVA 42");
  });
});

describe("stopPlaceToAutocompleteResult", () => {
  it("maps and dedupes transport modes onto the embedded transit stop", () => {
    const result = stopPlaceToAutocompleteResult(STOP, "de");
    expect(result).toEqual({
      id: "eva:8000207",
      label: "Köln Hbf",
      sublabel: "Köln",
      coordinates: [6.9589, 50.9431],
      type: "transit_stop",
      transitStop: {
        id: "eva:8000207",
        name: "Köln Hbf",
        lat: 50.9431,
        lng: 6.9589,
        modes: ["rail", "tram"],
        provider: "db-ris",
      },
      rawCategory: "railway/station",
    });
  });

  it("defaults modes to rail when no transports are available", () => {
    const result = stopPlaceToAutocompleteResult({
      evaNumber: "1",
      names: { DE: { nameLong: "X" } },
      position: { longitude: 1, latitude: 2 },
    });
    expect(result.transitStop?.modes).toEqual(["rail"]);
    expect(result.sublabel).toBeUndefined();
  });
});

describe("stopPlaceToPlace", () => {
  it("builds an eva-scheme place with a station category", () => {
    expect(stopPlaceToPlace(STOP, "en")).toMatchObject({
      id: "eva:8000207",
      primaryScheme: "eva",
      ids: { eva: "8000207" },
      name: "Cologne Central",
      address: "Cologne Central",
      city: "Cologne",
      coordinates: [6.9589, 50.9431],
      category: "Train Station",
      rawCategory: "railway/station",
    });
  });
});

describe("buildStationDetail", () => {
  it("emits platform, transfer-time and local-service sections when populated", () => {
    const detail = buildStationDetail(
      [{ name: "1", length: 400, height: 76, accessibility: { stepFreeAccess: true } }],
      [{ type: "COMMUTER", defaultDuration: 5 }],
      [{ name: "Lockers", category: "storage" }],
    );
    expect(detail.source).toBe("db-station");
    expect(detail.attribution.text).toBe("Deutsche Bahn");
    expect(detail.sections).toHaveLength(3);
    expect(detail.sections[0]?.type).toBe("table");
    expect(detail.sections[2]?.items).toEqual(["Lockers (storage)"]);
  });

  it("omits sections that have no rows or items", () => {
    const detail = buildStationDetail([], [], []);
    expect(detail.sections).toEqual([]);
  });

  it("lists a local service without its category when none is given", () => {
    const detail = buildStationDetail([], [], [{ name: "WiFi" }]);
    expect(detail.sections[0]?.items).toEqual(["WiFi"]);
  });
});
