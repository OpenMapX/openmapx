// Rebuild the light style's POI filters from one category/zoom policy. The
// dark-style generator then copies this structure while recoloring the paint.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { poiIconImageExpression, poiTextColourExpression } from "./poi-icon-registry.mjs";
import {
  landmarkExpression,
  notabilityExpression,
  poiRankLimitExpression,
  streetFixtureFilter,
  transitStopExpression,
} from "./poi-visibility-policy.mjs";

const path = fileURLToPath(new URL("../public/styles/openmapx-streets.json", import.meta.url));
const style = JSON.parse(readFileSync(path, "utf8"));
const spritePath = fileURLToPath(new URL("../public/styles/sprite.json", import.meta.url));
const spriteNames = Object.keys(JSON.parse(readFileSync(spritePath, "utf8")));
const fixtureClasses = [
  "waste_basket",
  "bicycle_parking",
  "bollard",
  "motorcycle_parking",
  "cycle_barrier",
];
// The last of these in the style draws above the others.
const levelLayerIds = ["poi-level-3", "poi-level-2", "poi-level-1"];
const LANDMARK_LAYER_ID = "poi-landmark";

const rank = ["coalesce", ["get", "rank"], 9999];
const groundLevel = ["any", ["!", ["has", "level"]], ["==", ["get", "level"], 0]];
const isStation = ["==", ["get", "subclass"], "station"];
const name = ["get", "name"];
const textColour = poiTextColourExpression();
const halo = {
  "text-halo-blur": 0.5,
  "text-halo-color": "rgba(255,255,255,0.8)",
  "text-halo-width": 1,
};

function iconImage() {
  return poiIconImageExpression(spriteNames);
}

function upsertLayer(layer, afterId) {
  const existing = style.layers.findIndex((candidate) => candidate.id === layer.id);
  if (existing !== -1) style.layers.splice(existing, 1);
  const anchor = style.layers.findIndex((candidate) => candidate.id === afterId);
  style.layers.splice(anchor + 1, 0, layer);
}

for (const layer of style.layers) {
  if (layer.id === "house-number") {
    layer.minzoom = 19;
    layer.layout["text-size"] = 9;
    layer.layout["text-padding"] = 1;
    continue;
  }
  if (layer.id === "poi-street-fixtures") {
    layer.minzoom = 19;
    layer.filter = streetFixtureFilter();
    layer.layout["text-offset"] = [0, 1.05];
    continue;
  }
  if (layer.id === "poi-railway") {
    // A station is where several lines meet, so it reads first: a badge like
    // every other POI, and a bold name in the transport colour.
    layer.layout["icon-image"] = iconImage();
    layer.layout["icon-size"] = ["interpolate", ["linear"], ["zoom"], 13, 0.85, 16, 1.05];
    layer.layout["text-font"] = ["Noto Sans Bold"];
    layer.layout["text-size"] = 12.5;
    layer.layout["text-offset"] = [0, 1.1];
    layer.paint = { "text-color": textColour, ...halo };
    continue;
  }
  if (!levelLayerIds.includes(layer.id)) continue;

  const filter = [
    "all",
    ["==", ["geometry-type"], "Point"],
    ["<=", rank, poiRankLimitExpression()],
    ["!", ["in", ["get", "class"], ["literal", fixtureClasses]]],
    groundLevel,
    ["!", landmarkExpression()],
    ["!", isStation],
  ];
  if (layer.id === "poi-level-1") {
    filter.push(["<=", rank, 14], ["has", "name"], ["!=", ["get", "class"], "park"]);
  } else {
    filter.push(
      layer.id === "poi-level-2" ? ["all", [">=", rank, 15], ["<=", rank, 24]] : [">=", rank, 25],
      ["any", ["!=", ["get", "class"], "park"], ["!", ["has", "name"]]],
      ["any", [">=", ["zoom"], 19], ["has", "name"]],
    );
  }
  layer.filter = filter;
  layer.layout["icon-image"] = iconImage();
  // Stops are drawn as small icons only; the app's TransitStopLabels names
  // each stop once however many platforms carry its name.
  layer.layout["icon-size"] = [
    "interpolate",
    ["linear"],
    ["zoom"],
    14,
    ["case", transitStopExpression(), 0.62, 0.78],
    16,
    ["case", transitStopExpression(), 0.82, 1],
  ];
  layer.layout["text-field"] = ["case", transitStopExpression(), "", name];
  layer.layout["text-offset"] = [0, 1.05];
  layer.paint = { "text-color": textColour, ...halo };
}

// Landmarks, picked by how widely their name is translated, get a larger badge,
// a bold name and first claim on space, from a zoom out where other POIs are hidden.
upsertLayer(
  {
    id: LANDMARK_LAYER_ID,
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "poi",
    minzoom: 13,
    filter: [
      "all",
      ["==", ["geometry-type"], "Point"],
      ["has", "name"],
      groundLevel,
      landmarkExpression(),
    ],
    layout: {
      "icon-image": iconImage(),
      "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 1, 16, 1.3],
      "symbol-sort-key": ["-", 0, notabilityExpression()],
      "text-anchor": "top",
      "text-field": name,
      "text-font": ["Noto Sans Bold"],
      "text-max-width": 9,
      "text-offset": [0, 1.3],
      "text-padding": 2,
      "text-size": ["interpolate", ["linear"], ["zoom"], 13, 12, 16, 13.5],
    },
    paint: { "text-color": textColour, ...halo },
  },
  // MapLibre places the upper layers' labels first, so landmarks and stations
  // sit above the street names and keep their label where the two would overlap.
  "highway-name-major",
);
upsertLayer(
  style.layers.find((layer) => layer.id === "poi-railway"),
  LANDMARK_LAYER_ID,
);

writeFileSync(path, `${JSON.stringify(style, null, 2)}\n`);
execFileSync("npx", ["biome", "format", "--write", path], { stdio: "ignore" });
console.log("[apply-poi-visibility] updated light style POI filters");
