#!/usr/bin/env node

// Build the browser-side ESM modules that the page exposes to community
// integration bundles via an import map. Integrations declare `react`,
// `react/jsx-runtime`, `react/jsx-dev-runtime`, and `@openmapx/core` as
// external; the page's import map points those bare imports at the files
// emitted here so React + the platform store/context registry stay singletons.
//
// Runs in `prebuild` (and `predev`) so the files exist before Next serves
// `apps/web/public/`. Re-runs are cheap thanks to esbuild's metafile-less
// single-file builds.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, "..");
const outDir = resolve(webRoot, "public/runtime");

mkdirSync(outDir, { recursive: true });

const MODULES = [
  { id: "react", outfile: "react.js" },
  { id: "react/jsx-runtime", outfile: "react-jsx-runtime.js" },
  { id: "react/jsx-dev-runtime", outfile: "react-jsx-dev-runtime.js" },
  { id: "@openmapx/core", outfile: "openmapx-core.js" },
];

for (const mod of MODULES) {
  await build({
    entryPoints: [{ in: mod.id, out: mod.outfile.replace(/\.js$/, "") }],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outdir: outDir,
    absWorkingDir: webRoot,
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' },
  });
}

// Emit an importmap.json so any consumer (the page, tools, tests) has a single
// source of truth for which bare specifiers the runtime promises.
const importmap = {
  imports: Object.fromEntries(MODULES.map((m) => [m.id, `/runtime/${m.outfile}`])),
};
writeFileSync(resolve(outDir, "importmap.json"), `${JSON.stringify(importmap, null, 2)}\n`);
