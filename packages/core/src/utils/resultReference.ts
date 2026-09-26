import type { BoundingBox, LngLat } from "../types/geometry";
import { haversineDistance } from "./coordinates";
import { bboxCenter } from "./sortResults";

export type DistanceReference = {
  coordinates: LngLat;
  kind: "search_origin" | "search_area_center";
  name?: string;
};

export function validResultCoordinates(
  coordinates: LngLat | null | undefined,
): coordinates is LngLat {
  return (
    Array.isArray(coordinates) &&
    coordinates.length === 2 &&
    Number.isFinite(coordinates[0]) &&
    Number.isFinite(coordinates[1]) &&
    coordinates[0] >= -180 &&
    coordinates[0] <= 180 &&
    coordinates[1] >= -90 &&
    coordinates[1] <= 90
  );
}

export function resolveDistanceReference(input: {
  anchor: { name: string; coordinates: LngLat } | null;
  searchBbox: BoundingBox | null;
  searchOrigin?: { coordinates: LngLat; name?: string } | null;
}): DistanceReference | null {
  const origin = input.searchOrigin ?? input.anchor;
  if (origin && validResultCoordinates(origin.coordinates)) {
    return {
      kind: "search_origin",
      coordinates: origin.coordinates,
      ...(origin.name ? { name: origin.name } : {}),
    };
  }
  const bbox = input.searchBbox;
  if (
    !bbox ||
    ![bbox.west, bbox.east, bbox.south, bbox.north].every(Number.isFinite) ||
    bbox.west > bbox.east ||
    bbox.south > bbox.north
  )
    return null;
  const coordinates = bboxCenter(bbox);
  return validResultCoordinates(coordinates) ? { kind: "search_area_center", coordinates } : null;
}

export function resultDistanceMetres(
  reference: DistanceReference | null,
  coordinates: LngLat | null | undefined,
): number | null {
  if (
    !reference ||
    !validResultCoordinates(reference.coordinates) ||
    !validResultCoordinates(coordinates)
  )
    return null;
  return haversineDistance(reference.coordinates, coordinates);
}
