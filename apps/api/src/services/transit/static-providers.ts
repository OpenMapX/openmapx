/**
 * Static provider attribution for hand-crafted transit integrations.
 * Mirrors packages/core/src/constants/transit.ts PROVIDER_ATTRIBUTION —
 * the API serves this via GET /api/transit/providers, the frontend
 * keeps its own copy as a pre-fetch fallback.
 */
export const STATIC_PROVIDER_ATTRIBUTION: Record<
  string,
  { label: string; url: string; license?: string; licenseUrl?: string }
> = {
  db: {
    label: "Deutsche Bahn",
    url: "https://www.deutschebahn.com",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  tfl: {
    label: "Powered by TfL Open Data",
    url: "https://tfl.gov.uk/info-for/open-data-users/",
    license: "OGL v2.0",
    licenseUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/2/",
  },
  irail: {
    label: "iRail / NMBS-SNCB",
    url: "https://www.irail.be",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  mbta: {
    label: "MassDOT/MBTA",
    url: "https://www.mbta.com/developers",
    license: "MassDOT License",
    licenseUrl: "https://www.mass.gov/doc/developers-license-agreement-11132009/download",
  },
  "opendata-ch": {
    label: "opentransportdata.swiss",
    url: "https://opentransportdata.swiss",
    license: "Custom Terms",
    licenseUrl: "https://opentransportdata.swiss/en/terms-of-use/",
  },
  vbb: {
    label: "VBB",
    url: "https://www.vbb.de",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  bvg: {
    label: "BVG / VBB",
    url: "https://www.bvg.de",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
  transitous: {
    label: "Transitous",
    url: "https://transitous.org",
    license: "AGPL-3.0",
    licenseUrl: "https://www.gnu.org/licenses/agpl-3.0.html",
  },
  transitland: {
    label: "Transitland",
    url: "https://www.transit.land",
    license: "Custom ToS",
    licenseUrl: "https://www.transit.land/terms",
  },
  overpass: {
    label: "OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
    license: "ODbL",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/",
  },
  otp: {
    label: "OpenTripPlanner",
    url: "https://www.opentripplanner.org",
    license: "LGPL-3.0",
    licenseUrl: "https://www.gnu.org/licenses/lgpl-3.0.html",
  },
};
