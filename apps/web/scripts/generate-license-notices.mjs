#!/usr/bin/env node
// Build-time generator for the /licenses page.
//
// Walks production deps from app-web, app-api, data-manager, the workspace
// `packages/`, and every built-in integration under `integrations/`, then writes a static JSON
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
  resolve(repoRoot, "services/data-manager/package.json"),
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

// Vendored map style. apps/web/public/styles/openmapx-{streets,dark}.json are a
// recolored derivative of OSM Bright (openmaptiles/osm-bright-gl-style). It is
// not an npm dependency, so scanLicenses doesn't see it — add its notice by
// hand. Dual-licensed BSD-3-Clause (style code) AND CC-BY-4.0 (visual design;
// the design license requires a visible "© OpenMapTiles" map credit, shown by
// the map's attribution control).
notices.push({
  name: "OSM Bright map style (openmaptiles/osm-bright-gl-style)",
  version: "vendored",
  license: "BSD-3-Clause AND CC-BY-4.0",
  projectUrl: "https://github.com/openmaptiles/osm-bright-gl-style",
  licenseText: `Copyright (c) 2024, MapTiler.com & OpenMapTiles contributors.
Copyright (c) 2014, Mapbox.
All rights reserved.

Derived from "Mapbox Open Styles" (https://github.com/mapbox/mapbox-gl-styles),
with modifications by MapTiler.com & OpenMapTiles contributors and a further
recolor by OpenMapX.

# Code license: BSD 3-Clause License

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
* Neither the name of the copyright holder nor the names of its contributors
  may be used to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

# Design license: CC-BY 4.0

The visual design features of the style are licensed under the Creative Commons
Attribution 4.0 license (https://creativecommons.org/licenses/by/4.0/). Products
or services using maps derived from the OpenMapTiles schema must visibly credit
"© OpenMapTiles" with a link to https://openmaptiles.org/, alongside
"© OpenStreetMap contributors". OpenMapX shows both in the map's attribution
control.`,
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
