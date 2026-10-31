import { afterEach, describe, expect, it, vi } from "vitest";
import { deCambioClient } from "../de-cambio-client.js";
import { parseDeNwBielefeldCsv } from "../de-nw-bielefeld-client.js";
import { mergeRegionalStations } from "../merge-stations.js";

afterEach(() => vi.unstubAllGlobals());

const BIELEFELD_BBOX = { west: 8.4, south: 51.95, east: 8.65, north: 52.1 };

function stubCambioStations(stations: unknown[]) {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).endsWith("/BIL/stations") ? Response.json(stations) : Response.json([]),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Cambio stations", () => {
  it("maps a station's vehicle count to the vehicles it holds, not to availability", async () => {
    stubCambioStations([
      {
        id: "19-17",
        displayName: "Babenhausen",
        name: "Babenhausen",
        geoposition: { latitude: 52.05551866, longitude: 8.51813793 },
        stationType: "FIXED",
        vehicleClasses: [{ id: "19-393", displayName: "S Kleinwagen" }],
        vehicleCount: 4,
      },
    ]);

    const [station] = await deCambioClient.search(BIELEFELD_BBOX);

    expect(station).toMatchObject({
      id: "de-cambio/BIL/19-17",
      name: "Babenhausen",
      capacity: 4,
      operator: "Cambio Bielefeld",
    });
    expect(station.availableVehicles).toBeUndefined();
    expect(station.isActive).toBeUndefined();
  });

  it("does not mark a station with no vehicles assigned as inactive", async () => {
    stubCambioStations([
      {
        id: "19-2625",
        displayName: "König",
        name: "König",
        geoposition: { latitude: 52.02, longitude: 8.53 },
        stationType: "FIXED",
        vehicleCount: 0,
      },
    ]);

    const [station] = await deCambioClient.search(BIELEFELD_BBOX);

    expect(station.capacity).toBe(0);
    expect(station.availableVehicles).toBeUndefined();
    expect(station.isActive).toBeUndefined();
  });

  it("merges with the Bielefeld open-data station without inventing availability", async () => {
    stubCambioStations([
      {
        id: "19-2",
        displayName: "Siggi",
        name: "Siggi",
        geoposition: { latitude: 52.0284764, longitude: 8.5233383 },
        stationType: "FIXED",
        vehicleCount: 2,
      },
    ]);
    const cambio = await deCambioClient.search(BIELEFELD_BBOX);
    const bielefeld = parseDeNwBielefeldCsv(
      [
        "WKT;gid;website;name;addr_street;addr_housenumber;level;capacity;description",
        '"POINT (8.5233383 52.0284764)";2;https://example.com/book;Siggi;Weststraße;68;;3;"Hinter dem Kiosk."',
      ].join("\n"),
    );

    const [merged, ...rest] = mergeRegionalStations([...cambio, ...bielefeld]);

    expect(rest).toEqual([]);
    expect(merged.id).toBe("de-cambio/BIL/19-2");
    expect(merged.capacity).toBe(2);
    expect(merged.website).toBe("https://example.com/book");
    expect(merged.availableVehicles).toBeUndefined();
    expect(merged.isActive).toBeUndefined();
  });
});
