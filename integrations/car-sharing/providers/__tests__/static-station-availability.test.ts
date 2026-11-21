import {
  createPassthroughCache,
  fakeHttpClient,
  nth,
} from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDeNwBielefeldCsv } from "../de-nw-bielefeld-client.js";
import { parseDeNwWuppertalGeoJson } from "../de-nw-wuppertal-client.js";
import { deStadtteilautoClient } from "../de-stadtteilauto-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("static car-sharing feeds", () => {
  it("maps a Münster station's vehicle count to the vehicles it holds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          String(url).endsWith("stations.json")
            ? [
                {
                  id: "42",
                  displayName: "Hafen",
                  geoposition: { latitude: 51.95, longitude: 7.64 },
                  vehicleCount: 3,
                },
              ]
            : [],
        ),
      ),
    );

    const station = nth(
      await deStadtteilautoClient.search(
        { west: 7.5, south: 51.9, east: 7.7, north: 52 },
        { cache: createPassthroughCache(), http: fakeHttpClient() },
      ),
      0,
    );

    expect(station.capacity).toBe(3);
    expect(station.availableVehicles).toBeUndefined();
    expect(station.isActive).toBeUndefined();
  });

  it("maps a Bielefeld station's capacity without claiming availability", () => {
    const stations = parseDeNwBielefeldCsv(
      [
        "WKT;gid;website;name;addr_street;addr_housenumber;level;capacity;description",
        '"POINT (8.5233383 52.0284764)";2;https://example.com/book;Siggi;Weststraße;68;;2;"Hinter dem Kiosk."',
      ].join("\n"),
    );

    const station = nth(stations, 0);
    expect(station.capacity).toBe(2);
    expect(station.availableVehicles).toBeUndefined();
    expect(station.isActive).toBeUndefined();
  });

  it("keeps a Wuppertal station with no listed vehicles active-unknown and leaves a missing operator absent", () => {
    const stations = parseDeNwWuppertalGeoJson(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [7.15, 51.25] },
            properties: { NAME_STAT: "Elberfeld", ANZ_FAHRZ: 0 },
          },
        ],
      }),
    );

    const station = nth(stations, 0);
    expect(station.capacity).toBe(0);
    expect(station.availableVehicles).toBeUndefined();
    expect(station.isActive).toBeUndefined();
    expect(station.operator).toBeUndefined();
  });
});
