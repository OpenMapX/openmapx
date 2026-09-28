// Rebuild the light style's POI filters from one category/zoom policy. The
// dark-style generator then copies this structure while recoloring the paint.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { poiRankLimitExpression, streetFixtureFilter } from "./poi-visibility-policy.mjs";

const path = fileURLToPath(new URL("../public/styles/openmapx-streets.json", import.meta.url));
const style = JSON.parse(readFileSync(path, "utf8"));
const fixtureClasses = [
  "waste_basket",
  "bicycle_parking",
  "bollard",
  "motorcycle_parking",
  "cycle_barrier",
];

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
  if (!["poi-level-1", "poi-level-2", "poi-level-3"].includes(layer.id)) continue;

  const rank = ["coalesce", ["get", "rank"], 9999];
  const filter = [
    "all",
    ["==", ["geometry-type"], "Point"],
    ["<=", rank, poiRankLimitExpression()],
    ["!", ["in", ["get", "class"], ["literal", fixtureClasses]]],
    ["any", ["!", ["has", "level"]], ["==", ["get", "level"], 0]],
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
  layer.layout["text-offset"] = [0, 1.05];
}

writeFileSync(path, `${JSON.stringify(style, null, 2)}\n`);
execFileSync("npx", ["biome", "format", "--write", path], { stdio: "ignore" });
console.log("[apply-poi-visibility] updated light style POI filters");
