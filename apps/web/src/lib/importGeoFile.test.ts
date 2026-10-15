import { placesToGeoJson, placesToGpx, placesToKml } from "@openmapx/core/saved-place-export";
import { expect, it } from "vitest";
import { parseGeoFile } from "./importGeoFile";

const name = { sourceId: "names", name: "Name supplier", attributionText: "Name notice" };
const coordinates = {
  sourceId: "geometry",
  name: "Coordinate supplier",
  url: "https://geometry.example/rights",
  attributionText: 'Original <a href="https://geometry.example/license">notice</a>',
};
const place = {
  name: "A & B <Place>",
  address: "Original address",
  lat: 50,
  lng: 8,
  fieldContributors: { name: [name], address: [], lat: [coordinates], lng: [coordinates] },
};

it.each(["geojson", "gpx", "kml"] as const)(
  "round trips saved receipts through %s and projects only painted coordinates",
  (format) => {
    const text =
      format === "geojson"
        ? JSON.stringify(placesToGeoJson([place]))
        : format === "gpx"
          ? placesToGpx([place])
          : placesToKml([place]);
    const parsed = parseGeoFile(`trip.${format}`, text);
    expect(parsed?.features).toHaveLength(1);
    if (!parsed) throw new Error("File rejected");
    const feature = parsed.features[0];
    expect(feature.properties?.fieldContributors).toEqual(place.fieldContributors);
    expect(JSON.parse(feature.properties?._mapAttributions)).toEqual([coordinates]);
    expect(feature.geometry).toEqual({ type: "Point", coordinates: [8, 50] });
  },
);

it("does not trust imported map-owner metadata or malformed capture and never executes supplied HTML", () => {
  const features = parseGeoFile(
    "untrusted.geojson",
    JSON.stringify({
      type: "Feature",
      properties: {
        name: '<img src=x onerror="alert(1)">',
        _mapAttributions: JSON.stringify([name]),
        fieldContributors: { phone: [name] },
      },
      geometry: { type: "Point", coordinates: [8, 50] },
    }),
  )?.features;
  if (!features) throw new Error("File rejected");
  expect(features[0].properties?._mapAttributions).toBe("[]");
  expect(features[0].properties?.fieldContributors).toBeUndefined();
  expect(document.querySelector("img")).toBeNull();
});

it("keeps duplicate waypoint receipts matched independently in GPX", () => {
  const second = { ...place, fieldContributors: { lat: [name], lng: [name] } };
  const parsed = parseGeoFile("duplicates.gpx", placesToGpx([place, second]));
  expect(parsed?.features.map((f) => JSON.parse(f.properties?._mapAttributions))).toEqual([
    [coordinates],
    [name],
  ]);
});
