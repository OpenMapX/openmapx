// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyMapLibreRuntimeAssets, maplibreVersion } from "../../scripts/maplibre-runtime.mjs";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("maplibre-gl/package.json"));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MapLibre runtime build assets", () => {
  it("copies the installed worker and shared module as a version-matched pair", () => {
    const root = mkdtempSync(resolve(tmpdir(), "openmapx-maplibre-runtime-"));
    temporaryRoots.push(root);

    copyMapLibreRuntimeAssets(root);

    for (const filename of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
      expect(readFileSync(resolve(root, "maplibre-gl", maplibreVersion, filename))).toEqual(
        readFileSync(resolve(packageRoot, "dist", filename)),
      );
    }
  });
});
