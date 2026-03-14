/**
 * Static provider attribution for hand-crafted transit integrations.
 * Mirrors packages/core/src/constants/transit.ts PROVIDER_ATTRIBUTION —
 * the API serves this via GET /api/transit/providers, the frontend
 * keeps its own copy as a pre-fetch fallback.
 */
export const STATIC_PROVIDER_ATTRIBUTION: Record<string, { label: string; url: string }> = {
  db: { label: "Deutsche Bahn", url: "https://www.deutschebahn.com" },
  tfl: { label: "Powered by TfL Open Data", url: "https://tfl.gov.uk/info-for/open-data-users/" },
  irail: { label: "iRail / NMBS-SNCB", url: "https://www.irail.be" },
  mbta: { label: "MassDOT/MBTA", url: "https://www.mbta.com/developers" },
  "opendata-ch": { label: "opentransportdata.swiss", url: "https://opentransportdata.swiss" },
  vbb: { label: "VBB (CC BY 4.0)", url: "https://www.vbb.de" },
  bvg: { label: "BVG / VBB (CC BY 4.0)", url: "https://www.bvg.de" },
  transitous: { label: "Transitous", url: "https://transitous.org" },
  transitland: { label: "Transitland", url: "https://www.transit.land" },
  overpass: {
    label: "OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
  },
  otp: { label: "OpenTripPlanner", url: "https://www.opentripplanner.org" },
};
