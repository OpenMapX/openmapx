// @vitest-environment node
// Pure filesystem static-analysis guardrail — no DOM, so it runs in the node
// project even though it lives under apps/web (mirrors integrationFrontendFiles).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The whole app source tree, not just `components/map`: `RouteSearchResultsLayer.tsx`
// (under `components/navigation`) shipped a raw `addLayer` that a `components/map`-only
// sweep missed entirely. Layer-adding code isn't confined to `components/` by
// convention — Next's App Router puts page-level components under `app/` too — so the
// honest scope is everything under `apps/web/src`.
const WEB_SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));
// This file lives at `components/map/`, so reaching the repo-root `integrations/`
// dir needs one more `../` than a file directly under `apps/web/src/lib/` would
// (see `lib/integrationFrontendFiles.test.ts`).
const INTEGRATIONS_DIR = fileURLToPath(new URL("../../../../../integrations", import.meta.url));

/**
 * `layerStack.ts` is the one module allowed to call `addLayer` directly.
 * `AreaPickerMap.tsx` and `OfflineMapView.tsx` construct their own standalone
 * `new maplibregl.Map(...)` instances for offline-region selection/preview —
 * they never touch the shared `MapContext` map every migrated layer draws on,
 * so there is no shared stack for them to race and nothing for `addLayerInSlot`
 * to anchor them against.
 */
const ALLOWED = new Set(["layerStack.ts", "AreaPickerMap.tsx", "OfflineMapView.tsx"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Every layer must declare a slot. A raw `addLayer` puts the layer wherever the
 * creating effect happened to run, which is what made the satellite overlay
 * repaint over the wildfire markers and the incidents fall under the route.
 * `addLayerInSlot` is the only supported way in.
 *
 * The `/\.addLayer\s*\(/` text match is a static approximation, not a real
 * call-graph check: destructuring the method off a map instance (`const {
 * addLayer } = map`) before calling it would slip past this regex. MapLibre's
 * methods rely on internal `this` state, so an unbound call would likely
 * misbehave at runtime rather than work silently — but this guardrail can't
 * prove that, only catch the direct-call form every offender so far has used.
 */
describe("map layers declare a slot", () => {
  const files = [
    ...sourceFiles(WEB_SRC_DIR),
    ...sourceFiles(INTEGRATIONS_DIR).filter((f) => /\/(map|route)-layer\.tsx$/.test(f)),
  ];

  it("finds map layer files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("has no direct addLayer call outside layerStack", () => {
    const offenders = files.filter((file) => {
      if (ALLOWED.has(path.basename(file))) return false;
      return /\.addLayer\s*\(/.test(fs.readFileSync(file, "utf8"));
    });
    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });
});

/**
 * Creating a source and filling it must be one operation. When they are two, a
 * style change recreates the source empty and whatever pushes the data never
 * re-runs — the layer then renders nothing, with no error and no failing test.
 * `useMapLayerGroup` takes the data as part of the descriptor, so the split
 * cannot occur; a raw `addSource` or `setData` is how a layer reaches around it.
 *
 * Scoped to `apps/web/src`. The `integrations/*` overlays are a separate
 * migration: they already create and fill in one pass, so they are not at risk,
 * and listing all twenty here would say nothing.
 *
 * The allowlist is the not-yet-migrated set. It only ever shrinks — deleting the
 * last entry is what finishes this work.
 */
const UNMIGRATED = new Set([
  // The primitive and the helper it replaces.
  "mapLayerGroup.ts",
  "layerStyleUtils.ts",
  // Standalone `new maplibregl.Map(...)` instances for offline region select and
  // preview — no shared stack, nothing to race.
  "AreaPickerMap.tsx",
  "OfflineMapView.tsx",
  // Awaiting the follow-up migration.
  "RasterBaseLayer.tsx",
  "RouteSearchResultsLayer.tsx",
  "SelectedStopInfrastructureLayer.tsx",
  "StreetLevelCoverageLayer.tsx",
  "TransitItineraryLayer.tsx",
  "TransitRouteLayer.tsx",
  "VehicleLiveLayer.tsx",
]);

describe("map layers keep their data with their sources", () => {
  // `src/test/` is the harness, not app code — the fake map implements these
  // methods rather than calling them.
  const files = sourceFiles(WEB_SRC_DIR).filter(
    (file) => !file.includes(`${path.sep}src${path.sep}test${path.sep}`),
  );

  it("has no direct addSource or setData call in a migrated file", () => {
    const offenders = files.filter((file) => {
      if (UNMIGRATED.has(path.basename(file))) return false;
      const text = fs.readFileSync(file, "utf8");
      return /\.addSource\s*\(/.test(text) || /\.setData\s*\(/.test(text);
    });
    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });
});
