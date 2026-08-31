import { createPassthroughCache } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchNextbike } from "./nextbike-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Nextbike bulk feed", () => {
  it("accepts the reviewed production feed size while still using a bounded response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              countries: [
                {
                  country: "DE",
                  country_name: "Germany",
                  cities: [
                    {
                      uid: 1,
                      name: "Berlin",
                      alias: "berlin",
                      lat: 52.52,
                      lng: 13.4,
                      available_bikes: 2,
                      places: [
                        {
                          uid: 2,
                          name: "Alexanderplatz",
                          lat: 52.521,
                          lng: 13.413,
                          bikes: 2,
                          bike_racks: 10,
                          free_racks: 8,
                          spot: true,
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
            {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": "28561122",
              },
            },
          ),
      ),
    );

    await expect(
      searchNextbike(
        { west: 13.3, south: 52.4, east: 13.5, north: 52.6 },
        createPassthroughCache(),
      ),
    ).resolves.toEqual([expect.objectContaining({ id: "nextbike/1/2", name: "Alexanderplatz" })]);
  });
});
