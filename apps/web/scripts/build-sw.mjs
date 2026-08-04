// Bundles the service worker (src/sw.ts -> public/sw.js) and stamps it with a
// per-build id via esbuild `define`. Without a build-varying value the output is
// byte-identical across builds, so browsers never see a "new" service worker and
// the in-app "update available" prompt (SwUpdateNotice) never fires. The id is
// woven into the app-shell cache name in sw.ts, so it must change every deploy.
//
// Source of the id, in priority order:
//   1. SW_BUILD_ID env var (CI passes the git SHA as a Docker build arg)
//   2. the local git short SHA (dev builds)
//   3. a timestamp fallback (no env, no git)
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { copyMapLibreRuntimeAssets, maplibreVersion } from "./maplibre-runtime.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveSwBuildId(env = process.env) {
  const fromEnv = (env.SW_BUILD_ID ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    // Fixed argv, no shell — nothing interpolated.
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return `dev-${Date.now()}`;
  }
}

if (process.argv[1]?.endsWith("build-sw.mjs")) {
  const buildId = resolveSwBuildId();
  copyMapLibreRuntimeAssets(resolve(webRoot, "public/runtime"));
  await build({
    entryPoints: ["src/sw.ts"],
    bundle: true,
    outfile: "public/sw.js",
    format: "iife",
    platform: "browser",
    define: {
      "process.env.NODE_ENV": '"production"',
      __MAPLIBRE_VERSION__: JSON.stringify(maplibreVersion),
      __SW_BUILD_ID__: JSON.stringify(buildId),
    },
  });
  console.log(`[build:sw] public/sw.js built (build id: ${buildId})`);
}
