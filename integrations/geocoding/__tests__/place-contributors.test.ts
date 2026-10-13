import { OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";
import { afterEach, expect, it, vi } from "vitest";
import { lookupByOsmRef } from "../place-lookup";

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
