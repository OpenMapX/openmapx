import { cumulativeDistances, type LngLat, projectRoadAlertsOntoRoute } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import kaarst from "../__fixtures__/kaarst-maubisstrasse-alerts.json";
import { type AlertOverpassElement, mapAlertElements } from "../navigation-alerts.js";

/**
 * The reported case end to end: real OSM data around Maubisstraße ×
 * Grünstraße / Matthias-Claudius-Straße in Kaarst, through the server's
 * mapping and the client's projection. Routes follow the OSM node coordinates,
 * as routing engines return them.
 */

// Maubisstraße northbound (ways 54853313 then 50331114), past both junctions.
const MAUBISSTRASSE_NORTH: LngLat[] = [
  [6.6198476, 51.2283255],
  [6.6197848, 51.2284531],
  [6.6196281, 51.2287679],
  [6.6195035, 51.2290159],
  [6.6194395, 51.2291434],
  [6.6193669, 51.2292898],
  [6.6192329, 51.2295545], // Grünstraße junction
  [6.6191694, 51.2296792], // Matthias-Claudius-Straße junction
  [6.6191018, 51.2298064],
  [6.6186169, 51.2307556],
  [6.6185488, 51.230883],
  [6.6184792, 51.231015],
];

// Grünstraße westbound (way 24578686 against its digitisation), then north.
const GRUENSTRASSE_WEST_THEN_NORTH: LngLat[] = [
  [6.621325, 51.2295746],
  [6.6208627, 51.2295717],
  [6.6207464, 51.2295698],
  [6.6202304, 51.2295646],
  [6.6193297, 51.2295553], // stop sign
  ...MAUBISSTRASSE_NORTH.slice(6),
];

// Matthias-Claudius-Straße eastbound (way 158227908 with its digitisation), then north.
const MATTHIAS_CLAUDIUS_EAST_THEN_NORTH: LngLat[] = [
  [6.6168493, 51.2298234],
  [6.6177193, 51.2297045], // hump
  [6.6178706, 51.2296834],
  [6.6179895, 51.2296808], // hump
  [6.61838, 51.2296721],
  [6.6190694, 51.2296783], // stop sign
  ...MAUBISSTRASSE_NORTH.slice(7),
];

// Leaving the junction eastward along Grünstraße, with its digitisation.
const MAUBISSTRASSE_THEN_GRUENSTRASSE_EAST: LngLat[] = [
  ...MAUBISSTRASSE_NORTH.slice(0, 7),
  [6.6193297, 51.2295553],
  [6.6202304, 51.2295646],
  [6.6207464, 51.2295698],
  [6.6208627, 51.2295717],
  [6.621325, 51.2295746],
];

const raw = mapAlertElements(kaarst.elements as AlertOverpassElement[]);

function alertsAlong(route: LngLat[]): string[] {
  const cum = cumulativeDistances(route);
  return projectRoadAlertsOntoRoute(raw, route, cum, {
    fromMeters: 0,
    toMeters: cum[cum.length - 1],
  })
    .map((alert) => alert.id)
    .sort();
}

describe("approach alerts at Maubisstraße, Kaarst", () => {
  it("warns of nothing on Maubisstraße, the priority road", () => {
    expect(alertsAlong(MAUBISSTRASSE_NORTH)).toEqual([]);
  });

  it("warns of the Grünstraße stop sign arriving along Grünstraße", () => {
    expect(alertsAlong(GRUENSTRASSE_WEST_THEN_NORTH)).toEqual(["stop:8557831413"]);
  });

  it("warns of the speed bumps and the stop sign along Matthias-Claudius-Straße", () => {
    expect(alertsAlong(MATTHIAS_CLAUDIUS_EAST_THEN_NORTH)).toEqual([
      "stop:8557831412",
      "traffic_calming:9272074397",
      "traffic_calming:9272074398",
    ]);
  });

  it("does not warn of the Grünstraße stop sign when leaving the junction past it", () => {
    expect(alertsAlong(MAUBISSTRASSE_THEN_GRUENSTRASSE_EAST)).toEqual([]);
  });
});
