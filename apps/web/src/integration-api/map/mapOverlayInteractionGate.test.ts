// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const ROOTS = ["integrations", "apps/web/src/integration-api/components"];

// Overlays answer hover and clicks through `useMapOverlayInteraction`, which
// owns the one pointer listener and the cursor for every overlay on the map.
// These files keep their own pointer handling, each for the reason given.
const OWN_POINTER_HANDLING = new Map([
  [
    "integrations/overlay-tool-measurement/map-layer.tsx",
    "Editing tool: drags vertices and shows crosshair and grab cursors while it owns the map.",
  ],
  [
    "integrations/overlay-tool-travel-time/map-layer.tsx",
    "Editing tool: places and drags its origin with crosshair and grab cursors.",
  ],
]);

const POINTER_LISTENER = /\.on\(\s*["'`](?:mousemove|mouseenter|mouseleave|mouseover)["'`]/;
const CURSOR_WRITE = /\.style\.cursor\s*=(?!=)/;

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

function offenders(files: Array<{ file: string; source: string }>): string[] {
  const found: string[] = [];
  for (const { file, source } of files) {
    if (OWN_POINTER_HANDLING.has(file)) continue;
    source.split("\n").forEach((line, index) => {
      if (POINTER_LISTENER.test(line)) found.push(`${file}:${index + 1}: own pointer listener`);
      if (CURSOR_WRITE.test(line)) found.push(`${file}:${index + 1}: writes the cursor`);
    });
  }
  return found;
}

const sources = ROOTS.flatMap((root) => collect(path.join(REPO_ROOT, root))).map((full) => ({
  file: path.relative(REPO_ROOT, full).split(path.sep).join("/"),
  source: fs.readFileSync(full, "utf8"),
}));

describe("map overlay interaction gate", () => {
  it("leaves hover and the cursor to the shared overlay interaction pipeline", () => {
    expect(offenders(sources)).toEqual([]);
  });

  it("names only files that still handle the pointer themselves", () => {
    const stale = [...OWN_POINTER_HANDLING.keys()].filter((file) => {
      const entry = sources.find((candidate) => candidate.file === file);
      return !entry || (!POINTER_LISTENER.test(entry.source) && !CURSOR_WRITE.test(entry.source));
    });
    expect(stale).toEqual([]);
  });

  it("catches both forms it guards against", () => {
    const probe = [
      { file: "integrations/probe/map-layer.tsx", source: 'map.on("mousemove", onMove);' },
      { file: "integrations/probe/other.tsx", source: 'map.getCanvas().style.cursor = "pointer";' },
    ];
    expect(offenders(probe)).toEqual([
      "integrations/probe/map-layer.tsx:1: own pointer listener",
      "integrations/probe/other.tsx:1: writes the cursor",
    ]);
  });
});
