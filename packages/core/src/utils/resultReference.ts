import type { BoundingBox, LngLat } from "../types/geometry";
import { haversineDistance } from "./coordinates";
import { bboxCenter, validResultCoordinates } from "./sortResults";

export { validResultCoordinates } from "./sortResults";

export type DistanceReference = {
  coordinates: LngLat;
  kind: "search_origin" | "user_location" | "search_area_center";
  name?: string;
};

export function resolveDistanceReference(input: {
  anchor: { name: string; coordinates: LngLat } | null;
  searchBbox: BoundingBox | null;
  searchOrigin?: { coordinates: LngLat; name?: string } | null;
  userLocation?: LngLat | null;
}): DistanceReference | null {
  const origin = input.searchOrigin ?? input.anchor;
  if (origin && validResultCoordinates(origin.coordinates)) {
    return {
      kind: "search_origin",
      coordinates: origin.coordinates,
      ...(origin.name ? { name: origin.name } : {}),
    };
  }
  if (validResultCoordinates(input.userLocation)) {
    return { kind: "user_location", coordinates: input.userLocation };
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
