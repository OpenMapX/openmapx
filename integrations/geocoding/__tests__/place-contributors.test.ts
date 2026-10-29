import { OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";
import { afterEach, expect, it, vi } from "vitest";
import { fetchOsmBoundary, lookupByOsmRef } from "../place-lookup";

afterEach(() => vi.unstubAllGlobals());

it("preserves the proven underlying OSM receipt when a detail lookup produces a place", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              osm_type: "node",
              osm_id: 42,
              name: "Station",
              lat: "50",
              lon: "6",
              display_name: "Station",
              address: {},
              extratags: { phone: "+49" },
            },
          ]),
        ),
    ),
  );
  const place = await lookupByOsmRef("node", "42", "osm:node/42");
  expect(place.contributors).toEqual([OPENSTREETMAP_ATTRIBUTION]);
  expect(place.contributors?.[0]).not.toBe(OPENSTREETMAP_ATTRIBUTION);
  expect(place.phone).toBe("+49");
});

it("captures the OSM supplier with the acquired boundary and bounding box", async () => {
  const boundary = {
    type: "Polygon",
    coordinates: [
      [
        [6, 50],
        [7, 50],
        [7, 51],
        [6, 50],
      ],
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              osm_type: "relation",
              osm_id: 42,
              boundingbox: ["50", "51", "6", "7"],
              geojson: boundary,
            },
          ]),
        ),
    ),
  );
  const result = await fetchOsmBoundary("relation/42");
  expect(result).toMatchObject({
    boundary,
    boundingBox: [6, 50, 7, 51],
    contributors: [OPENSTREETMAP_ATTRIBUTION],
  });
  expect(result?.contributors?.[0]).not.toBe(OPENSTREETMAP_ATTRIBUTION);
});
