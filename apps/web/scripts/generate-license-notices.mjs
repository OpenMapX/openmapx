#!/usr/bin/env node
// Build-time generator for the /licenses page.
//
// Walks production deps from app-web, app-api, the workspace `packages/`, and
// every built-in integration under `integrations/`, then writes a static JSON
// file consumed by `apps/web/src/app/(legal)/licenses/page.tsx`. Re-runs
// under `predev` and `prebuild` so the file is always present in dev and
// production builds.
//
// Community integrations are not scanned here — they ship as immutable
// artifacts that may not be installed at web-build time. The licenses page
// reads `dist/licenses.json` from each installed artifact at request time
// and merges those notices on top of this static list.

import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanLicenses } from "@openmapx/core/licenses";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const repoRoot = resolve(webRoot, "..", "..");
const outDir = resolve(webRoot, "src/generated");
const outPath = resolve(outDir, "open-source-licenses.json");

const rootPackageJsonPaths = [
  resolve(webRoot, "package.json"),
  resolve(repoRoot, "apps/api/package.json"),
  ...workspaceChildren("packages"),
  ...workspaceChildren("integrations"),
].filter((p) => existsSync(p));

const notices = scanLicenses({
  rootPackageJsonPaths,
  // OpenMapX workspace packages aren't third-party deps with their own license
  // obligation; the integration source files have their own MIT notice in the
  // repo root. Drop them from the public-facing list.
  skipNamePrefixes: ["@openmapx/", "@integrations/", "@better-auth/passkey", "web", "api"],
});

const payload = {
  generatedAt: new Date().toISOString(),
  rootCount: rootPackageJsonPaths.length,
  notices,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outPath}.tmp`, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
renameSync(`${outPath}.tmp`, outPath);

console.log(
  `[generate-license-notices] ${notices.length} notices from ${rootPackageJsonPaths.length} roots → ${outPath}`,
);

function workspaceChildren(dir) {
  const abs = resolve(repoRoot, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."),
    )
    .map((entry) => resolve(abs, entry.name, "package.json"))
    .filter((p) => existsSync(p));
}
