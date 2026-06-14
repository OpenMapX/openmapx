// Generate apps/web/public/styles/openmapx-dark.json from openmapx-streets.json
// by recoloring it to a dark ("night") palette. The light style is a recolored
// derivative of OSM Bright (openmaptiles/osm-bright-gl-style, BSD-3-Clause);
// OSM Bright has no official dark twin, so we derive ours by mapping each
// light color to a dark equivalent. STRUCTURE (layers, order, filters, layout,
// zoom expressions) is preserved exactly — only color values change.
//
// Colors are routed by the paint property they appear in:
//   - text-*color (not halo) -> light text  (textMap)
//   - *halo*               -> dark halo     (haloMap)
//   - fill/line/bg/outline -> dark surface  (surfaceMap)
//
// Re-run after editing the light style: `node apps/web/scripts/generate-dark-map-style.mjs`.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STYLES = fileURLToPath(new URL("../public/styles/", import.meta.url));
const SRC = `${STYLES}openmapx-streets.json`;
const OUT = `${STYLES}openmapx-dark.json`;

// Surface colors (land, water, parks, roads, buildings, boundaries) — used in
// fill / line / background / *outline color properties.
const surfaceMap = {
  // Land base + landuse fills (light blue-greys -> dark blue-greys)
  "#f7f6f6": "#1b212b", // background / land
  "#e8e9ed": "#242b35",
  "#e8eaec": "#242b35",
  "#d8d9dd": "#2a313c",
  "#f0f4ff": "#20283a",
  // Warm landuse (retail / sand cream -> dark warm)
  "#f5edd8": "#2a2820",
  "#f5eed0": "#2c2a22",
  // Health / amenity (light red -> dark red)
  "#fce8e6": "#34221f",
  // Road fills — lifted well above the land colour so the street network reads
  // on the dark base (land luma ~32 < minor ~68 < motorway ~85).
  "#c7d5e2": "#434b59", // minor / secondary / tertiary / primary / link fill
  "#8ba5c1": "#5a6476", // trunk / motorway fill (brightest)
  "#c8c8c8": "#3c424b", // paths
  "#ccd6e1": "#3a414d", // railway
  "#c8cfd6": "#39414e",
  "#cdd3da": "#39414e",
  "#d0d4d8": "#39414e", // aeroway
  // Road casings — darker than both the fills and the land so roads get a crisp
  // edge rather than melting into the background.
  "#b8c6d2": "#12161d",
  "#bac8d6": "#12161d",
  "#b8bfc8": "#12161d",
  "#b0c0cf": "#12161d", // link / primary casing
  "#7492ad": "#10151c", // motorway / trunk casing
  "hsl(0, 0%, 70%)": "hsl(220, 6%, 32%)",
  "hsl(248, 7%, 70%)": "hsl(248, 6%, 33%)",
  // Water (teal/cyan -> deep teal-navy)
  "#90daee": "#15333f",
  "rgba(144, 217, 237, 0.7)": "rgba(21, 51, 63, 0.85)",
  "rgba(154, 189, 214, 1)": "rgba(43, 74, 90, 1)",
  // Parks / greens (light -> dark green, keep relative ordering)
  "#aaeac2": "#1c3a29",
  "#b3efcb": "#1f4030",
  "#c3f1d5": "#224432",
  "#d0f6e0": "#264a37",
  "#d8f5e4": "#284d3a",
  // White road segments (steps etc.) -> light grey so they read like other roads
  "#fff": "#4b5563",
  // Subtle alpha fills/outlines (recompute for a dark base)
  "hsla(0, 0%, 0%, 0.03)": "hsla(0, 0%, 100%, 0.05)",
  "hsla(210, 15%, 90%, 0.4)": "hsla(210, 15%, 16%, 0.5)",
  "hsla(220, 10%, 70%, 0.5)": "hsla(220, 12%, 40%, 0.5)",
  "hsla(220, 10%, 75%, 0.5)": "hsla(220, 12%, 42%, 0.5)",
  "hsla(220, 10%, 75%, 0.6)": "hsla(220, 12%, 42%, 0.6)",
  "hsla(220, 8%, 93%, 0.2)": "hsla(220, 10%, 20%, 0.3)",
  "hsla(30, 10%, 95%, 0.15)": "hsla(30, 12%, 16%, 0.2)",
  "hsla(30, 10%, 95%, 0.25)": "hsla(30, 12%, 16%, 0.3)",
  "hsla(30, 10%, 95%, 0.35)": "hsla(30, 12%, 16%, 0.4)",
  "hsla(30, 10%, 95%, 0.4)": "hsla(30, 12%, 16%, 0.45)",
  "hsla(30, 12%, 90%, 0.25)": "hsla(30, 12%, 16%, 0.3)",
  "hsla(30, 18%, 90%, 0.3)": "hsla(30, 15%, 17%, 0.35)",
};

// Label text (dark -> light)
const textMap = {
  "#1f1f1f": "#e8eaed",
  "#3c3c3c": "#e3e6ea",
  "#3c4043": "#e8eaed",
  "#5f6368": "#9aa0a6",
  "#4a5568": "#99a0ab",
  "#80868b": "#aab0b6",
  "#4a89b8": "#7fb0cc", // water labels
  "#ffffff": "#e8eaed",
};

// Text halos (white -> dark, so light labels stay legible on the dark base)
const haloMap = {
  "#ffffff": "rgba(11, 15, 20, 0.9)",
  "rgba(255,255,255,0.7)": "rgba(11, 15, 20, 0.75)",
  "rgba(255,255,255,0.75)": "rgba(11, 15, 20, 0.8)",
  "rgba(255,255,255,0.8)": "rgba(11, 15, 20, 0.85)",
  "rgba(255,255,255,0.85)": "rgba(11, 15, 20, 0.88)",
  "rgba(255,255,255,0.9)": "rgba(11, 15, 20, 0.9)",
};

const isColor = (v) =>
  typeof v === "string" && (/^#([0-9a-f]{3,8})$/i.test(v) || /^(rgb|hsl)a?\(/i.test(v));

const unmapped = new Set();

function mapColor(value, map, propName) {
  const key = value.toLowerCase() in map ? value.toLowerCase() : value;
  if (key in map) return map[key];
  unmapped.add(`${propName}: ${value}`);
  return value; // leave unchanged so the leak is visible + warned
}

function recolor(node, propName) {
  if (isColor(node)) {
    if (/halo/.test(propName)) return mapColor(node, haloMap, propName);
    if (propName === "text-color" || propName === "icon-color")
      return mapColor(node, textMap, propName);
    return mapColor(node, surfaceMap, propName);
  }
  if (Array.isArray(node)) return node.map((v) => recolor(v, propName));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = recolor(v, propName);
    return out;
  }
  return node;
}

const style = JSON.parse(readFileSync(SRC, "utf8"));
style.name = "OpenMapX Dark";
style.metadata = { ...(style.metadata ?? {}), "openmapx:variant": "dark" };
style.layers = style.layers.map((layer) => {
  if (!layer.paint) return layer;
  // Road shields render their ref text on fixed-colour sprite backgrounds
  // (yellow Bundes-/Land-/Kreisstraße, blue Autobahn, US route shields) that do
  // not change with the map theme. Recoloring their text to light would put
  // white on yellow — so leave shield text at its light-mode colour (dark on
  // yellow, white on blue) for contrast.
  if (/shield/.test(layer.id)) return layer;
  const paint = {};
  for (const [prop, val] of Object.entries(layer.paint)) {
    paint[prop] = /color/.test(prop) ? recolor(val, prop) : val;
  }
  return { ...layer, paint };
});

writeFileSync(OUT, `${JSON.stringify(style, null, 2)}\n`);
// Match the repo's JSON formatting (biome collapses short arrays) so the
// generated file passes `biome check` and stays byte-stable across re-runs.
execFileSync("npx", ["biome", "format", "--write", OUT], { stdio: "ignore" });

if (unmapped.size > 0) {
  console.error(`[generate-dark-map-style] ${unmapped.size} unmapped color(s) left light:`);
  for (const u of unmapped) console.error(`  ${u}`);
  process.exit(1);
}
console.log(
  `[generate-dark-map-style] wrote openmapx-dark.json (${style.layers.length} layers, all colors mapped)`,
);
