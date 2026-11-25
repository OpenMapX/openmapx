import { describe, expect, it } from "vitest";
import { persistedPlaceIdSchema, savedCheckQuerySchema } from "../../api/contracts/saved/schemas";
import { makeId, parseId } from "../identified";
import {
  coordinateId,
  coordinateIdPosition,
  isPersistablePlaceId,
  persistablePlaceId,
  SESSION_LOCAL_PLACE_ID_SCHEMES,
  savedPlaceKey,
  savedRowKey,
} from "../placeIds";

describe("place id grammar", () => {
  it("builds and parses ids whose scheme is lower case with hyphens", () => {
    expect(makeId("style-poi", { "style-poi": "42" })).toBe("style-poi:42");
    expect(parseId("osm:node/123")).toEqual({ scheme: "osm", value: "node/123" });
    expect(parseId("rdw:manager/area:7")).toEqual({ scheme: "rdw", value: "manager/area:7" });
  });

  it("refuses a scheme outside the grammar", () => {
    expect(() => makeId("stylePoi", { stylePoi: "42" })).toThrow();
    expect(() => makeId("street_level", { street_level: "1" })).toThrow();
    for (const id of ["stylePoi:42", "1osm:node/1", "-osm:x", "Osm:x", ":x", "osm:", "osm"])
      expect(parseId(id), id).toBeNull();
  });

  it("encodes a coordinate as lat,lng at six decimals", () => {
    expect(coordinateId([-77.02573, 38.88859])).toBe("38.888590,-77.025730");
    expect(parseId(`coordinate:${coordinateId([6.08, 50.78])}`)).toEqual({
      scheme: "coordinate",
      value: "50.780000,6.080000",
    });
  });
});

describe("saved place keys", () => {
  it("match a durable place by its id and a session-local one by its position", () => {
    expect(savedPlaceKey({ id: "osm:node/1", coordinates: [13.4, 52.5] })).toBe("osm:node/1");
    for (const scheme of SESSION_LOCAL_PLACE_ID_SCHEMES)
      expect(savedPlaceKey({ id: `${scheme}:x`, coordinates: [13.40000012, 52.5] })).toBe(
        "coordinate:52.500000,13.400000",
      );
    expect(savedRowKey({ placeId: null, lat: 52.5, lng: 13.40000012 })).toBe(
      "coordinate:52.500000,13.400000",
    );
    expect(savedRowKey({ placeId: "osm:node/1", lat: 52.5, lng: 13.4 })).toBe("osm:node/1");
    expect(coordinateIdPosition("coordinate:52.500000,-13.400000")).toEqual({
      lat: 52.5,
      lng: -13.4,
    });
    expect(coordinateIdPosition("osm:node/1")).toBeNull();
  });

  it("the check contract accepts durable ids and coordinate ids only", () => {
    const accepted = (placeId: string) => savedCheckQuerySchema.safeParse({ placeId }).success;
    expect(accepted("osm:node/1")).toBe(true);
    expect(accepted("coordinate:52.500000,13.400000")).toBe(true);
    expect(accepted("coordinate:52.5,13.4")).toBe(false);
    for (const scheme of ["style-poi", "saved", "label"])
      expect(accepted(`${scheme}:1`)).toBe(false);
  });
});

describe("persistable place ids", () => {
  it("keeps a durable id and drops a session-local or malformed one", () => {
    expect(persistablePlaceId("osm:node/123")).toBe("osm:node/123");
    expect(persistablePlaceId("openseamap-harbour:4")).toBe("openseamap-harbour:4");
    for (const scheme of SESSION_LOCAL_PLACE_ID_SCHEMES)
      expect(persistablePlaceId(`${scheme}:1`), scheme).toBeNull();
    expect(persistablePlaceId("stylePoi:42")).toBeNull();
    expect(persistablePlaceId(null)).toBeNull();
    expect(persistablePlaceId("")).toBeNull();
  });

  it("the saved-place contract accepts exactly the persistable ids", () => {
    const ids = [
      "osm:node/123",
      "overture:08f2a",
      "ca-iwls:5cebf1de3d0f4a073c4bb94e",
      "eva:8000105",
      ...SESSION_LOCAL_PLACE_ID_SCHEMES.map((scheme) => `${scheme}:1`),
      "stylePoi:42",
      "osm:",
      "no-scheme",
    ];
    for (const id of ids)
      expect(persistedPlaceIdSchema.safeParse(id).success, id).toBe(isPersistablePlaceId(id));
  });
});
