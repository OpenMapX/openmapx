import { afterEach, describe, expect, it, vi } from "vitest";
import { deCambioClient } from "../de-cambio-client.js";
import { parseDeNwBielefeldCsv } from "../de-nw-bielefeld-client.js";
import { mergeRegionalStations } from "../merge-stations.js";
import { clientMatchesBbox, regionMatchesBbox } from "../regional-client-types.js";

afterEach(() => vi.unstubAllGlobals());

const BIELEFELD_BBOX = { west: 8.4, south: 51.95, east: 8.65, north: 52.1 };

function stubCambioStations(stations: unknown[]) {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).endsWith("/BIL/stations") ? Response.json(stations) : Response.json([]),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubCambioRegion(code: string, stations: unknown[]) {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).endsWith(`/${code}/stations`) ? Response.json(stations) : Response.json([]),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bboxAround(lat: number, lng: number) {
  return { west: lng - 0.02, south: lat - 0.02, east: lng + 0.02, north: lat + 0.02 };
}

describe("Cambio region coverage", () => {
  // Each feed's farthest stations from its region's point, as served on 2026-10-31.
  it.each([
    ["VLA", "22-3220", "Genk", 50.968, 5.5125],
    ["VLA", "22-4957", "Tongeren", 50.7841, 5.4732],
    ["WAL", "20-4056", "Mouscron", 50.7458, 3.2187],
    ["WAL", "20-4562", "Arlon", 49.6786, 5.812],
    ["BRE", "1-4890", "Emden", 53.3686, 7.1961],
    ["KOE", "12-3790", "Düsseldorf", 51.2502, 6.7817],
    ["DOR", "64-5298", "Dortmund", 51.5236, 7.545],
  ])("queries the %s feed for station %s in %s", async (code, id, town, lat, lng) => {
    const fetchMock = stubCambioRegion(code, [
      { id, name: town, geoposition: { latitude: lat, longitude: lng }, vehicleCount: 1 },
    ]);

    const stations = await deCambioClient.search(bboxAround(lat, lng));

    expect(fetchMock).toHaveBeenCalledWith(
      `https://cwapi.cambio-carsharing.com/pub/${code}/stations`,
      expect.anything(),
    );
    expect(stations.map((station) => station.id)).toEqual([`de-cambio/${code}/${id}`]);
  });

  it("matches the registry's bbox pre-filter for those stations", () => {
    expect(clientMatchesBbox(deCambioClient, bboxAround(50.968, 5.5125))).toBe(true);
    expect(clientMatchesBbox(deCambioClient, bboxAround(51.5236, 7.545))).toBe(true);
  });
});

describe("region bbox matching", () => {
  const region = { center: [7, 51] as [number, number], radiusKm: 50 };

  it("pads longitude by the radius at the region's latitude", () => {
    // At 51° N a degree of longitude spans about 70 km, so 50 km is about 0.71°.
    expect(regionMatchesBbox(region, { west: 7.65, south: 50.9, east: 7.7, north: 51.1 })).toBe(
      true,
    );
    expect(regionMatchesBbox(region, { west: 7.8, south: 50.9, east: 7.85, north: 51.1 })).toBe(
      false,
    );
  });

  it("pads latitude by the radius", () => {
    expect(regionMatchesBbox(region, { west: 6.9, south: 51.42, east: 7.1, north: 51.5 })).toBe(
      true,
    );
    expect(regionMatchesBbox(region, { west: 6.9, south: 51.5, east: 7.1, north: 51.6 })).toBe(
      false,
    );
  });
});

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
