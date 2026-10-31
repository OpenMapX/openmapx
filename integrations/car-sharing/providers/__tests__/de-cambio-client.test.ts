import type { IntegrationDataSource } from "@openmapx/integration-framework";
import { createSharedMobilityContributorResolver } from "@openmapx/integration-framework/shared-mobility-provider";
import { createPassthroughCache } from "@openmapx/integration-framework/testing";
import type { SharedMobilityStation } from "@openmapx/mobility-core/shared-mobility";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../../manifest.json";
import { beCambioClient, deCambioClient } from "../de-cambio-client.js";
import { parseDeNwBielefeldCsv } from "../de-nw-bielefeld-client.js";
import { mergeRegionalStations } from "../merge-stations.js";
import { clientMatchesBbox, regionMatchesBbox } from "../regional-client-types.js";
import { createRegionalCarSharingRegistry } from "../registry.js";

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
    ["VLA", "22-3220", "Genk", 50.968, 5.5125, beCambioClient],
    ["VLA", "22-4957", "Tongeren", 50.7841, 5.4732, beCambioClient],
    ["WAL", "20-4056", "Mouscron", 50.7458, 3.2187, beCambioClient],
    ["WAL", "20-4562", "Arlon", 49.6786, 5.812, beCambioClient],
    ["BRE", "1-4890", "Emden", 53.3686, 7.1961, deCambioClient],
    ["KOE", "12-3790", "Düsseldorf", 51.2502, 6.7817, deCambioClient],
    ["DOR", "64-5298", "Dortmund", 51.5236, 7.545, deCambioClient],
  ])("queries the %s feed for station %s in %s", async (code, id, town, lat, lng, client) => {
    const fetchMock = stubCambioRegion(code, [
      { id, name: town, geoposition: { latitude: lat, longitude: lng }, vehicleCount: 1 },
    ]);

    const stations = await client.search(bboxAround(lat, lng));

    expect(fetchMock).toHaveBeenCalledWith(
      `https://cwapi.cambio-carsharing.com/pub/${code}/stations`,
      expect.anything(),
    );
    // Belgian stations keep the de-cambio id prefix, so their place ids are unchanged.
    expect(stations.map((station) => station.id)).toEqual([`de-cambio/${code}/${id}`]);
    expect(clientMatchesBbox(client, bboxAround(lat, lng))).toBe(true);
  });

  it("keeps each country's regions in its own client", () => {
    expect(clientMatchesBbox(deCambioClient, bboxAround(50.847, 4.356))).toBe(false);
    expect(clientMatchesBbox(beCambioClient, bboxAround(52.52, 13.405))).toBe(false);
  });
});

describe("Cambio credits", () => {
  const search = createRegionalCarSharingRegistry({
    clients: [deCambioClient, beCambioClient],
    cache: createPassthroughCache(),
    log: { warn: vi.fn(), error: vi.fn() } as never,
    resolveContributors: createSharedMobilityContributorResolver(
      manifest.dataSources as IntegrationDataSource[],
    ),
  });
  const licences = (station: SharedMobilityStation) =>
    station.contributors?.map((contributor) => [
      contributor.sourceId,
      contributor.licensing?.bindings.map((binding) =>
        binding.license.kind === "spdx" ? binding.license.expression : binding.license.kind,
      ),
    ]);

  it.each([
    ["BXL", "21-1", 50.847, 4.356, "be-cambio", "CC-BY-4.0"],
    ["KOE", "12-1", 50.938, 6.96, "de-cambio", "DL-DE-ZERO-2.0"],
  ])(
    "credits a %s station under its country's licence",
    async (code, id, lat, lng, source, spdx) => {
      stubCambioRegion(code, [
        { id, name: "Station", geoposition: { latitude: lat, longitude: lng } },
      ]);

      const [station] = await search(bboxAround(lat, lng));

      expect(station.id).toBe(`de-cambio/${code}/${id}`);
      expect(station.sources).toEqual([`${source}/${code}`]);
      expect(licences(station)).toEqual([[source, [spdx]]]);
    },
  );
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
