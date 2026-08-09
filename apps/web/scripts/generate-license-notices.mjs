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

// Foursquare OS Places is an upstream data source rather than an npm
// dependency. Preserve its NOTICE.txt alongside the generated dependency
// notices so the /licenses page exposes the source-specific Apache notice.
notices.push({
  name: "Foursquare OS Places",
  version: "data-source",
  license: "Apache-2.0",
  licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
  projectUrl: "https://opensource.foursquare.com/places-notice-txt/",
  licenseText: `© 2026 Foursquare Labs, Inc. All rights reserved.

The Foursquare OS Places dataset (the “Data”) is licensed under the Apache License, Version 2.0 (the “License”). You may not use, modify, or distribute the Data except in compliance with the License.

As set forth more fully in the License, if you use, modify, or distribute the Data, you must:
– provide recipients with a copy of the License.
– if applicable, include prominent notices to the extent you’ve changed the Data.
– preserve attribution to Foursquare, including preserving the full content of this NOTICE.txt file.

To ensure appropriate attribution to Foursquare, we recommend the following:
– if using/distributing the Data in flat file form as-is or after making changes/modifications: include this NOTICE.txt file, which may be modified to include an additional notice of your changes/modifications, if any.
– if using/distributing the Data in API form as-is or after making changes/modifications: include a copy of the content from this NOTICE.txt file prominently in your developer documentation for such API, which may be modified to include an additional notice of your changes/modifications, if any.

You may obtain a copy of the License at: http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in writing, the Data distributed under the License is distributed on an “AS IS” BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

See the License for the specific language governing permissions and limitations under the License.

We also encourage you to join our Placemaker community where you can contribute and provide suggestions to improve the accuracy of the Data for future releases for yourself and others.
`,
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
