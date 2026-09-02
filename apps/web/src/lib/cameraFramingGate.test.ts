// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const ROOTS = ["apps/web/src", "integrations"];

// Files that may drive MapLibre's camera directly. Framing goes through
// `useMap().fitBounds/flyTo` or `@/lib/cameraFraming` so panels and sheets are
// accounted for; these either implement that layer, own a standalone map with
// its own layout, or change pose (pitch/zoom/bearing) without framing content.
const ALLOWED = new Set([
  // Implements the wrappers every other caller is expected to use.
  "apps/web/src/integration-api/map/MapContext.tsx",
  // The framing layer itself: it resolves the padding target and moves the map.
  "apps/web/src/lib/cameraFraming.ts",
  // Restores the persisted viewport before any panel has laid itself out.
  "apps/web/src/components/map/MapCanvas.tsx",
  // Drives the follow camera by pose (pitch/zoom/bearing), not by framed content.
  "apps/web/src/lib/navigation/useNavCamera.ts",
  // Reveals the next transit leg through the navigation camera's own pipeline.
  "apps/web/src/lib/navigation/useTransitNavigationEngine.ts",
  // Snaps bearing to the street grid; a pose change, with no content to frame.
  "apps/web/src/lib/useAlignToStreets.ts",
  // Eases between the flat and globe projections, keeping the current framing.
  "apps/web/src/components/map/layers/GlobeProjection.tsx",
  // Standalone map in the offline settings page, with no app chrome over it.
  "apps/web/src/app/settings/offline/AreaPickerMap.tsx",
  // Standalone map in the offline settings page, with no app chrome over it.
  "apps/web/src/app/settings/offline/OfflineMapView.tsx",
  // Standalone shared-link viewer map, laid out without the app's panels.
  "apps/web/src/components/share/SharedMapView.tsx",
  // Small embedded preview map that fills its own box.
  "apps/web/src/integration-api/components/LocationMinimap.tsx",
  // Tilts the map into a 3D pose when the buildings overlay turns on.
  "integrations/overlay-3d-buildings/map-layer.tsx",
]);

const RAW_CAMERA = /\b(?:map|current)\?*\.(?:fitBounds|flyTo|jumpTo)\s*\(/;

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

export function rawCameraOffenders(files: Array<{ file: string; source: string }>): string[] {
  const offenders: string[] = [];
  for (const { file, source } of files) {
    if (ALLOWED.has(file)) continue;
    source.split("\n").forEach((line, index) => {
      if (RAW_CAMERA.test(line)) offenders.push(`${file}:${index + 1}`);
    });
  }
  return offenders;
}

describe("camera framing goes through the padded wrappers", () => {
  const files = ROOTS.flatMap((root) => collect(path.join(REPO_ROOT, root))).map((full) => ({
    file: path.relative(REPO_ROOT, full),
    source: fs.readFileSync(full, "utf8"),
  }));

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("has no raw fitBounds/flyTo/jumpTo outside the allowlist", () => {
    expect(rawCameraOffenders(files)).toEqual([]);
  });

  it("matcher rejects raw calls and accepts wrapper calls", () => {
    expect(rawCameraOffenders([{ file: "x.ts", source: "map.flyTo({ center })" }])).toEqual([
      "x.ts:1",
    ]);
    expect(rawCameraOffenders([{ file: "x.ts", source: "mapRef.current?.fitBounds(b)" }])).toEqual([
      "x.ts:1",
    ]);
    expect(rawCameraOffenders([{ file: "x.ts", source: "mapCtx.fitBounds(b, 80)" }])).toEqual([]);
    expect(rawCameraOffenders([{ file: "x.ts", source: "flyTo(coords, 15)" }])).toEqual([]);
  });
});
