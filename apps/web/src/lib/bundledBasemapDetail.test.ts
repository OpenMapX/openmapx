// @vitest-environment node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STOP_LABEL_COLOURS, STOP_RANK_LIMIT } from "@/components/map/stopLabelPoints";
import { poiFallbackTextColour, poiIconGroups } from "../../scripts/poi-icon-registry.mjs";
import {
  landmarkMinLanguages,
  notabilityLanguages,
  poiRankLimit,
  poiRankLimitExpression,
  poiVisibilityGroups,
  streetFixtureFilter,
  transitStopRankLimitExpression,
} from "../../scripts/poi-visibility-policy.mjs";

type Layer = {
  id: string;
  type: string;
  source?: string;
  "source-layer"?: string;
  minzoom?: number;
  filter?: unknown[];
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
};

type Properties = Record<string, unknown>;
type StyleFeature = { type: 1; properties: Properties };

const requireFromMapLibre = createRequire(import.meta.resolve("maplibre-gl/package.json"));
const styleSpec = requireFromMapLibre("@maplibre/maplibre-gl-style-spec") as {
  featureFilter: (
    filter: unknown,
    rootKey: string,
  ) => { filter: (globals: { zoom: number }, feature: StyleFeature) => boolean };
  createExpression: (
    input: unknown,
    rootKey: string,
  ) => {
    result: string;
    value: { evaluate: (globals: { zoom: number }, feature: StyleFeature) => unknown };
  };
};

function layers(name: string): Layer[] {
  const path = resolve(import.meta.dirname, `../../public/styles/${name}`);
  return (JSON.parse(readFileSync(path, "utf8")) as { layers: Layer[] }).layers;
}

function layer(styleName: string, id: string): Layer {
  const found = layers(styleName).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`${id} missing from ${styleName}`);
  return found;
}

function shows(target: Layer, zoom: number, properties: Properties): boolean {
  return styleSpec
    .featureFilter(target.filter, `layers.${target.id}.filter`)
    .filter({ zoom }, { type: 1, properties });
}

function evaluate(target: Layer, key: string, properties: Properties, zoom = 17): unknown {
  const value = target.layout?.[key] ?? target.paint?.[key];
  const expression = styleSpec.createExpression(value, `layers.${target.id}.${key}`);
  expect(expression.result).toBe("success");
  return expression.value.evaluate({ zoom }, { type: 1, properties });
}

function translatedInto(count: number): Properties {
  return Object.fromEntries(
    notabilityLanguages.slice(0, count).map((code: string) => [`name:${code}`, code]),
  );
}

const TV_TOWER = {
  class: "attraction",
  subclass: "attraction",
  name: "Berliner Fernsehturm",
  rank: 14,
  ...translatedInto(15),
};
const WORLD_CLOCK = {
  class: "attraction",
  subclass: "attraction",
  name: "Urania-Weltzeituhr",
  rank: 13,
  ...translatedInto(2),
};

describe("bundled basemap detail", () => {
  it("gives each ranked POI class one progressively increasing visibility schedule", () => {
    const classes = poiVisibilityGroups.flatMap((group) => group.classes);
    expect(new Set(classes).size).toBe(classes.length);
    for (const group of poiVisibilityGroups) {
      expect(group.limits).toHaveLength(7);
      expect(group.limits).toEqual(group.limits.toSorted((a, b) => a - b));
    }
    expect(poiRankLimit("restaurant", 15)).toBeGreaterThan(0);
    expect(poiRankLimit("restaurant", 17)).toBeGreaterThan(0);
  });

  it("brings stops in after the stations they belong to", () => {
    expect(poiRankLimit("railway", 14, "station")).toBeGreaterThan(0);
    expect(poiRankLimit("railway", 15, "tram_stop")).toBe(0);
    expect(poiRankLimit("bus", 15, "bus_stop")).toBe(0);
    expect(poiRankLimit("bus", 16, "bus_stop")).toBeGreaterThan(0);
    expect(poiRankLimit("bus", 19, "bus_stop")).toBe(9999);
    // A bus station is a destination, not a kerbside stop.
    expect(poiRankLimit("bus", 15, "bus_station")).toBe(poiRankLimit("bus", 15));
  });

  it("publishes stop labels on the same schedule and in the transport colour", () => {
    const transport = poiIconGroups.find((group) => group.category === "transport");
    expect(STOP_RANK_LIMIT).toEqual(transitStopRankLimitExpression());
    expect(STOP_LABEL_COLOURS.light.text).toBe(transport?.text);
    expect(STOP_LABEL_COLOURS.dark.text).toBe(transport?.darkText);
    for (const [styleName, colours] of [
      ["openmapx-streets.json", STOP_LABEL_COLOURS.light],
      ["openmapx-dark.json", STOP_LABEL_COLOURS.dark],
    ] as const) {
      const poi = layers(styleName).find((layer) => layer.id === "poi-level-1");
      expect(poi?.paint?.["text-halo-color"]).toBe(colours.halo);
    }
  });

  for (const styleName of ["openmapx-streets.json", "openmapx-dark.json"]) {
    it(`${styleName} labels house numbers and mountain summits at appropriate zooms`, () => {
      const styleLayers = layers(styleName);
      const houseNumbers = styleLayers.find((layer) => layer.id === "house-number");
      expect(houseNumbers).toMatchObject({
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "housenumber",
        minzoom: 19,
        layout: { "text-field": ["get", "housenumber"], "text-size": 9 },
      });

      const peaks = styleLayers.find((layer) => layer.id === "mountain-peak");
      expect(peaks).toMatchObject({
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "mountain_peak",
      });
      expect(peaks?.layout?.["text-field"]).toEqual([
        "concat",
        ["get", "name"],
        ["case", ["has", "ele"], ["concat", "\n", ["to-string", ["get", "ele"]], " m"], ""],
      ]);
    });

    it(`${styleName} distinguishes recreation and natural ground cover`, () => {
      const styleLayers = layers(styleName);
      expect(styleLayers.find((layer) => layer.id === "landuse-recreation")).toMatchObject({
        type: "fill",
        "source-layer": "landuse",
        filter: ["in", "class", "pitch", "playground", "stadium"],
      });
      expect(styleLayers.find((layer) => layer.id === "landcover-rock")).toMatchObject({
        type: "fill",
        "source-layer": "landcover",
        filter: ["==", "class", "rock"],
      });
      expect(styleLayers.find((layer) => layer.id === "landcover-wetland")).toMatchObject({
        type: "fill",
        "source-layer": "landcover",
        filter: ["==", "class", "wetland"],
      });
    });

    it(`${styleName} names protected and local parks without duplicate POI labels`, () => {
      const styleLayers = layers(styleName);
      expect(styleLayers.find((layer) => layer.id === "park-name")).toMatchObject({
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "park",
        minzoom: 7,
        filter: ["all", ["==", "$type", "Point"], ["has", "name"]],
        layout: { "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]] },
      });
      expect(styleLayers.find((layer) => layer.id === "poi-park-name")).toMatchObject({
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "poi",
        minzoom: 14,
        filter: [
          "all",
          ["==", "$type", "Point"],
          ["==", "class", "park"],
          ["has", "name"],
          ["any", ["!has", "level"], ["==", "level", 0]],
        ],
        layout: {
          "icon-image": "park_11",
          "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
        },
      });
      for (const id of ["poi-level-1", "poi-level-2", "poi-level-3"]) {
        const genericPoi = styleLayers.find((layer) => layer.id === id);
        const namedParkExclusion =
          id === "poi-level-1"
            ? ["!=", ["get", "class"], "park"]
            : ["any", ["!=", ["get", "class"], "park"], ["!", ["has", "name"]]];
        expect(genericPoi?.filter?.map((entry) => JSON.stringify(entry))).toContain(
          JSON.stringify(namedParkExclusion),
        );
        expect(styleLayers.findIndex((layer) => layer.id === "poi-park-name")).toBeGreaterThan(
          styleLayers.findIndex((layer) => layer.id === id),
        );
      }
    });

    it(`${styleName} progressively introduces destinations, commerce, and local detail`, () => {
      const styleLayers = layers(styleName);
      for (const id of ["poi-level-1", "poi-level-2", "poi-level-3"]) {
        const layer = styleLayers.find((candidate) => candidate.id === id);
        expect(layer?.filter?.map((entry) => JSON.stringify(entry))).toContain(
          JSON.stringify(["<=", ["coalesce", ["get", "rank"], 9999], poiRankLimitExpression()]),
        );
        expect(layer?.layout?.["text-offset"]).toEqual([0, 1.05]);
      }
      expect(styleLayers.find((layer) => layer.id === "poi-street-fixtures")?.filter).toEqual(
        streetFixtureFilter(),
      );
      expect(poiRankLimit("museum", 14)).toBeGreaterThan(poiRankLimit("restaurant", 14));
      expect(poiRankLimit("restaurant", 18)).toBeGreaterThan(poiRankLimit("restaurant", 16));
      expect(poiRankLimit("waste_basket", 18)).toBe(0);
      expect(poiRankLimit("motorcycle_parking", 18)).toBe(0);
      expect(poiRankLimit("cycle_barrier", 19)).toBe(0);
      expect(poiRankLimit("unlisted_category", 20)).toBe(9999);
    });

    it(`${styleName} singles out landmarks known well beyond their city`, () => {
      const landmark = layer(styleName, "poi-landmark");
      expect(landmark.minzoom).toBe(13);
      expect(shows(landmark, 13, TV_TOWER)).toBe(true);
      expect(shows(landmark, 13, WORLD_CLOCK)).toBe(false);
      expect(shows(landmark, 13, { ...WORLD_CLOCK, ...translatedInto(landmarkMinLanguages) })).toBe(
        true,
      );
      // Embassies carry many translated names but are not sights.
      expect(shows(landmark, 13, { ...TV_TOWER, class: "office", subclass: "diplomatic" })).toBe(
        false,
      );
      expect(landmark.layout?.["text-font"]).toEqual(["Noto Sans Bold"]);

      for (const id of ["poi-level-1", "poi-level-2", "poi-level-3"]) {
        expect(shows(layer(styleName, id), 18, TV_TOWER)).toBe(false);
      }
      expect(shows(layer(styleName, "poi-level-1"), 18, WORLD_CLOCK)).toBe(true);
    });

    it(`${styleName} lets landmarks and stations claim space before street names`, () => {
      const ids = layers(styleName).map((candidate) => candidate.id);
      for (const id of ["poi-landmark", "poi-railway"]) {
        expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf("highway-name-major"));
      }
      const station = layer(styleName, "poi-railway");
      expect(station.layout?.["text-font"]).toEqual(["Noto Sans Bold"]);
      expect(
        shows(layer(styleName, "poi-level-1"), 16, {
          class: "railway",
          subclass: "station",
          name: "Alexanderplatz",
          rank: 7,
        }),
      ).toBe(false);
    });

    it(`${styleName} colours each POI label like its badge`, () => {
      const dark = styleName === "openmapx-dark.json";
      const colourOf = (category: string) => {
        const group = poiIconGroups.find((candidate) => candidate.category === category);
        return dark ? group?.darkText : group?.text;
      };
      const poi = layer(styleName, "poi-level-1");
      const colour = (properties: Properties) => evaluate(poi, "text-color", properties);
      expect(colour({ class: "restaurant", subclass: "restaurant" })).toBe(colourOf("food"));
      expect(colour({ class: "shop", subclass: "clothes" })).toBe(colourOf("shopping"));
      // A subclass override takes its own group's colour, not its class's.
      expect(colour({ class: "shop", subclass: "chemist" })).toBe(colourOf("health"));
      expect(colour({ class: "museum", subclass: "museum" })).toBe(colourOf("culture"));
      expect(colour({ class: "unmapped_class" })).toBe(dark ? "#9aa0a6" : poiFallbackTextColour);
      expect(evaluate(layer(styleName, "poi-landmark"), "text-color", TV_TOWER)).toBe(
        colourOf("culture"),
      );
    });

    it(`${styleName} draws stops as icons and leaves their names to the stop labels`, () => {
      const poi = layer(styleName, "poi-level-1");
      const text = (properties: Properties) => evaluate(poi, "text-field", properties);
      expect(text({ class: "bus", subclass: "bus_stop", name: "Memhardstraße" })).toBe("");
      expect(text({ class: "railway", subclass: "tram_stop", name: "U Alexanderplatz" })).toBe("");
      expect(text({ class: "bus", subclass: "bus_station", name: "ZOB" })).toBe("ZOB");
      expect(text({ class: "restaurant", name: "Nordsee" })).toBe("Nordsee");
    });
  }
});
