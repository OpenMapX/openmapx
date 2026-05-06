/**
 * Register the id-scheme views that are owned by core itself: OSM (the
 * canonical open geodata reference), Wikidata (knowledge-graph ids that
 * tag places across producers), the synthetic internal schemes used for
 * coordinate-only places and UI-origin handles, plus the cross-reference
 * social/reviews schemes that ride along with Wikidata enrichment but
 * aren't bound to any one integration.
 *
 * Integrations register their own schemes in their setup functions (see
 * `integrations/geocoding-db-ris/index.ts`, `integrations/reviews-*`, …).
 *
 * Call {@link registerBuiltinIdSchemeViews} once at process/app boot
 * before any UI reads `place.ids`.
 */

import {
  buildFacebookUrl,
  buildFoursquareUrl,
  buildGoogleMapsUrl,
  buildInstagramUrl,
  buildYelpUrl,
} from "./external-platforms";
import { registerIdSchemeView } from "./presentation";
import { buildTripadvisorUrl } from "./tripadvisor";

let registered = false;

export function registerBuiltinIdSchemeViews(): void {
  if (registered) return;
  registered = true;

  // Canonical open identifiers

  registerIdSchemeView({
    scheme: "osm",
    label: "OSM",
    displayOrder: 10,
    buildUrl(value) {
      // Accept either `node/123` or `node/123/v2` etc.
      const m = value.match(/^(node|way|relation)\/(\d+)/);
      if (!m) return undefined;
      return `https://www.openstreetmap.org/${m[1]}/${m[2]}`;
    },
  });

  registerIdSchemeView({
    scheme: "wikidata",
    label: "Wikidata",
    displayOrder: 20,
    buildUrl(value) {
      if (!/^Q\d+$/i.test(value)) return undefined;
      return `https://www.wikidata.org/wiki/${value}`;
    },
  });

  // Transit / stations

  registerIdSchemeView({
    scheme: "eva",
    label: "EVA",
    displayOrder: 30,
    // EVA numbers don't have a canonical public URL — bahn.de's station
    // detail pages use a different slug-based id — so leave `buildUrl` off.
  });

  registerIdSchemeView({
    scheme: "gtfs",
    label: "GTFS",
    displayOrder: 40,
  });

  // Cross-reference schemes (populated by knowledge enrichment)

  registerIdSchemeView({
    scheme: "googleMaps",
    label: "Google Maps",
    displayOrder: 100,
    buildUrl: buildGoogleMapsUrl,
  });

  registerIdSchemeView({
    scheme: "yelp",
    label: "Yelp",
    displayOrder: 110,
    buildUrl: buildYelpUrl,
  });

  registerIdSchemeView({
    scheme: "tripadvisor",
    label: "Tripadvisor",
    displayOrder: 120,
    buildUrl: buildTripadvisorUrl,
  });

  registerIdSchemeView({
    scheme: "foursquare",
    label: "Foursquare",
    displayOrder: 130,
    buildUrl: buildFoursquareUrl,
  });

  registerIdSchemeView({
    scheme: "instagram",
    label: "Instagram",
    displayOrder: 140,
    buildUrl: buildInstagramUrl,
  });

  registerIdSchemeView({
    scheme: "facebook",
    label: "Facebook",
    displayOrder: 150,
    buildUrl: buildFacebookUrl,
  });

  // Internal schemes (hidden from user-facing id lists)

  for (const scheme of ["coordinate", "stylePoi", "label", "saved", "streetView"]) {
    registerIdSchemeView({ scheme, label: scheme, internal: true });
  }
}
