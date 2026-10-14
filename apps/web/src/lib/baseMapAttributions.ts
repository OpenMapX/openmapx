import type { Attribution } from "@openmapx/mobility-core/attribution";
import { OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";

/**
 * Canonical base-map credits — the single source of truth for the OSM /
 * OpenMapTiles / hosted-provider attribution shown across the app. `BaseAttributions`
 * registers these in the main map's attribution registry (rendered by
 * `MapFooter`); `baseMapCreditsHtml` in `map.ts` renders the same objects as HTML
 * for the embedded maps, which render them through `<MapCredits>` instead of
 * registering them. Defined once here so a credit/URL/license change can't
 * drift between the two rendering paths.
 *
 * Publisher names are proper nouns rendered verbatim across locales (the
 * providers treat them as untranslated identifiers); the leading "©" is
 * universal. Do not pipe these through next-intl.
 */
export const OSM_ATTRIBUTION: Attribution = OPENSTREETMAP_ATTRIBUTION;

export const OPENMAPTILES_ATTRIBUTION: Attribution = {
  sourceId: "openmaptiles",
  name: "© OpenMapTiles",
  url: "https://openmaptiles.org/",
  licensing: {
    version: 1,
    bindings: [
      {
        scope: "style",
        subject: "OpenMapTiles schema and map design",
        license: { kind: "spdx", expression: "CC-BY-4.0" },
        attribution: {
          placement: "visible",
          surfaces: ["map", "image"],
          basis: "provider-terms",
          reviewedAt: "2026-10-14",
          evidenceUrls: ["https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md"],
          reason: "Schema-derived maps require visible linked OpenMapTiles credit",
          compactText: '© <a href="https://openmaptiles.org/">OpenMapTiles</a>',
        },
      },
      {
        scope: "software",
        subject: "OpenMapTiles code",
        license: { kind: "spdx", expression: "BSD-3-Clause" },
      },
    ],
  },
};

export const OPENFREEMAP_ATTRIBUTION: Attribution = {
  sourceId: "openfreemap",
  name: "OpenFreeMap",
  url: "https://openfreemap.org/",
};

export const MAPTILER_ATTRIBUTION: Attribution = {
  sourceId: "maptiler",
  name: "© MapTiler",
  url: "https://www.maptiler.com/copyright/",
  licensing: {
    version: 1,
    bindings: [
      {
        scope: "service",
        subject: "MapTiler hosted map content",
        license: {
          kind: "custom",
          namespace: "publisher:maptiler",
          id: "LicenseRef-MapTiler-Map-Terms",
          name: "MapTiler General Terms and Conditions",
          url: "https://www.maptiler.com/terms/",
        },
        attribution: {
          placement: "visible",
          surfaces: ["map", "image"],
          basis: "provider-terms",
          reviewedAt: "2026-10-14",
          evidenceUrls: [
            "https://www.maptiler.com/terms/",
            "https://docs.maptiler.com/guides/map-design/attribution/add-attribution/",
          ],
          reason:
            "Keep hosted-map credit visible; retain official logo to cover free-account requirements",
          compactText: '© <a href="https://www.maptiler.com/copyright/">MapTiler</a>',
          logo: "maptiler",
        },
      },
    ],
  },
};
