import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("maplibre-gl/package.json");
const packageRoot = dirname(packageJsonPath);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

if (
  typeof packageJson.version !== "string" ||
  !/^[A-Za-z0-9._+-]{1,128}$/.test(packageJson.version)
) {
  throw new Error("maplibre-gl package has an invalid version");
}

export const maplibreVersion = packageJson.version;

const RUNTIME_FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

export function copyMapLibreRuntimeAssets(runtimeRoot) {
  const versionDir = resolve(runtimeRoot, "maplibre-gl", maplibreVersion);
  mkdirSync(versionDir, { recursive: true });
  for (const filename of RUNTIME_FILES) {
    copyFileSync(resolve(packageRoot, "dist", filename), resolve(versionDir, filename));
  }
}
