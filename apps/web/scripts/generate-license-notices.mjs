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
  // repo root. Drop them from the public-facing list. Prefixes must stay
  // scoped: a bare word such as "web" would also drop third-party packages
  // like web-streams-polyfill.
  skipNamePrefixes: ["@openmapx/", "@integrations/", "@better-auth/passkey"],
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

// The globe's bundled textures (apps/web/public/globe/README.md) are imagery,
// not npm dependencies; list their sources and licences here as well.
notices.push(
  {
    name: "ESO all-sky Milky Way panorama (eso0932a)",
    version: "data-source",
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    projectUrl: "https://www.eso.org/public/images/eso0932a/",
    licenseText:
      "Credit: ESO/S. Brunier. Changes: resized, recompressed and faint point stars removed for the globe's sky.\n",
  },
  {
    name: "NASA Black Marble 2016 (Earth at Night)",
    version: "data-source",
    license: "Public Domain",
    licenseUrl:
      "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
    projectUrl: "https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/",
    licenseText:
      "Credit: NASA Earth Observatory, using Suomi NPP VIIRS data processed at NASA's Goddard Space Flight Center. Resized for the globe's night side.\n",
  },
  {
    name: "Google Noto Sans script fallback fonts (Tifinagh, Thaana, Canadian Aboriginal, New Tai Lue, Cherokee, Ol Chiki)",
    version: "2.001–3.001 (vendored)",
    license: "OFL-1.1",
    licenseUrl: "https://openfontlicense.org/",
    projectUrl: "https://github.com/notofonts",
    licenseText: `Copyright 2022 The Noto Project Authors (https://github.com/notofonts/tifinagh) — Noto Sans Tifinagh 2.006
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/thaana) — Noto Sans Thaana 3.001
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/canadian-aboriginal) — Noto Sans Canadian Aboriginal 2.004
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/new-tai-lue) — Noto Sans New Tai Lue 2.004
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/cherokee) — Noto Sans Cherokee 2.001
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/ol-chiki) — Noto Sans Ol Chiki 2.003

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is available with a FAQ at: https://openfontlicense.org/

SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects, to support the font creation efforts of academic and linguistic communities, and to provide a free and open framework in which fonts may be shared and improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and redistributed freely as long as they are not sold by themselves. The fonts, including any derivative works, can be bundled, embedded, redistributed and/or sold with any software provided that any reserved names are not used by derivative works. The fonts and derivatives, however, cannot be released under any other type of license. The requirement for fonts to remain under this license does not apply to any document created using the fonts or their derivatives.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license. These can be included either as stand-alone text files, human-readable headers or in the appropriate machine-readable metadata fields within text or binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted by the corresponding Copyright Holder. This restriction only applies to the primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font Software shall not be used to promote, endorse or advertise any Modified Version, except to acknowledge the contribution(s) of the Copyright Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be distributed entirely under this license, and must not be distributed under any other license. The requirement for fonts to remain under this license does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
`,
  },
);

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
