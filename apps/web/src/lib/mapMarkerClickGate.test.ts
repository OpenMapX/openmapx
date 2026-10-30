// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const ROOTS = ["apps/web/src", "integrations"];

// MapLibre mounts DOM markers inside the map's event container, so a click on
// one is also a map click at that point. Markers go through
// `bindMapMarkerActivation`, which claims the click for the marker unless an
// active picker owns it. These files create markers that deliberately leave
// clicks to the map.
const PASS_THROUGH = new Set([
  // Hover elevation dot; `pointer-events: none`, never under the pointer.
  "apps/web/src/components/map/ElevationHoverMarker.tsx",
  // Navigation puck: decoration under the follow camera, nothing to activate.
  "apps/web/src/lib/navigation/useNavCamera.ts",
  // Standalone preview map with no click handling of its own.
  "apps/web/src/integration-api/components/LocationMinimap.tsx",
]);

// The binding itself is the one place a marker click listener belongs.
const BINDING = "apps/web/src/integration-api/map/mapMarkerActivation.ts";

const MAP_CLICK_HANDLER = /\.on\(\s*["'`]click["'`]/;
const CONSULTS_OWNERSHIP = /\b(?:getMapClickOwner|claimMapClick)\s*\(/;
const NEW_MARKER = /\bnew\s+(?:[A-Za-z_$][\w$]*\.)?Marker\s*\(/;
const NEW_MARKERS = new RegExp(NEW_MARKER.source, "g");
const BINDS_MARKER = /\bbindMapMarkerActivation\s*\(/g;
const RAW_CLICK_LISTENER = /\.addEventListener\(\s*["'`]click["'`]/;

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function markerClickOffenders(files: Array<{ file: string; source: string }>): string[] {
  const offenders: string[] = [];
  for (const { file, source } of files) {
    if (file === BINDING || !NEW_MARKER.test(source)) continue;
    const created = source.match(NEW_MARKERS)?.length ?? 0;
    const bound = source.match(BINDS_MARKER)?.length ?? 0;
    if (!PASS_THROUGH.has(file) && bound < created) {
      offenders.push(`${file}: creates a Marker without bindMapMarkerActivation`);
    }
    source.split("\n").forEach((line, index) => {
      if (RAW_CLICK_LISTENER.test(line)) offenders.push(`${file}:${index + 1}: raw click listener`);
    });
  }
  return offenders;
}

/**
 * A marker claims its click through map click ownership instead of stopping it,
 * so the click still reaches listeners outside the map. That only works while
 * every map click handler asks who owns the click before acting on it.
 */
function unownedMapClickHandlers(files: Array<{ file: string; source: string }>): string[] {
  return files
    .filter(({ source }) => MAP_CLICK_HANDLER.test(source) && !CONSULTS_OWNERSHIP.test(source))
    .map(({ file }) => file);
}

/**
 * A text match, not a call graph: it counts binding calls against marker
 * constructions per file, so a marker element built in one file and mounted in
 * another escapes it. Every marker so far is built where it is
 * mounted, and the gate makes each new one choose between binding and the
 * documented pass-through list.
 */
describe("DOM marker clicks stay off the map", () => {
  const files = ROOTS.flatMap((root) => collect(path.join(REPO_ROOT, root))).map((full) => ({
    file: path.relative(REPO_ROOT, full),
    source: fs.readFileSync(full, "utf8"),
  }));

  it("finds the markers it guards", () => {
    expect(files.filter(({ source }) => NEW_MARKER.test(source)).length).toBeGreaterThan(8);
  });

  it("binds every interactive marker through bindMapMarkerActivation", () => {
    expect(markerClickOffenders(files)).toEqual([]);
  });

  it("has every map click handler consult click ownership", () => {
    expect(unownedMapClickHandlers(files)).toEqual([]);
  });

  it("matcher flags map click handlers that ignore ownership", () => {
    const handler = 'map.on("click", LAYER, (e) => openFeature(e));';
    expect(unownedMapClickHandlers([{ file: "x.ts", source: handler }])).toEqual(["x.ts"]);
    const owned = `${handler}\nif (getMapClickOwner(e)) return;`;
    expect(unownedMapClickHandlers([{ file: "x.ts", source: owned }])).toEqual([]);
  });

  it("matcher flags unbound markers and raw click listeners", () => {
    const unbound = "const m = new maplibregl.Marker({ element }).addTo(map);";
    expect(markerClickOffenders([{ file: "x.ts", source: unbound }])).toEqual([
      "x.ts: creates a Marker without bindMapMarkerActivation",
    ]);
    const raw = [
      "bindMapMarkerActivation(el);",
      'el.addEventListener("click", onClick);',
      "new Marker({ element: el });",
    ].join("\n");
    expect(markerClickOffenders([{ file: "x.ts", source: raw }])).toEqual([
      "x.ts:2: raw click listener",
    ]);
    const bound = "bindMapMarkerActivation(el, { onActivate });\nnew ml.Marker({ element: el });";
    expect(
      markerClickOffenders([
        { file: "x.ts", source: `${bound}\nnew ml.Marker({ element: other });` },
      ]),
    ).toEqual(["x.ts: creates a Marker without bindMapMarkerActivation"]);
    expect(markerClickOffenders([{ file: "x.ts", source: bound }])).toEqual([]);
    expect(markerClickOffenders([{ file: "x.ts", source: "new MarkerCluster()" }])).toEqual([]);
  });

  it("exempts only files that still exist", () => {
    const missing = [...PASS_THROUGH, BINDING].filter(
      (file) => !fs.existsSync(path.join(REPO_ROOT, file)),
    );
    expect(missing).toEqual([]);
  });
});
