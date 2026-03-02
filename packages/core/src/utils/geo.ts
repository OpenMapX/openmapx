import type { BoundingBox, LngLat } from "../types/geometry";

/**
 * Return a bounding box that contains all provided points, with optional
 * padding in degrees.
 */
export function boundingBoxFromPoints(points: LngLat[], paddingDeg = 0): BoundingBox {
  if (points.length === 0) {
    throw new Error("boundingBoxFromPoints requires at least one point");
  }
  let west = points[0][0];
  let east = points[0][0];
  let south = points[0][1];
  let north = points[0][1];

  for (const [lng, lat] of points) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }

  return {
    west: west - paddingDeg,
    south: south - paddingDeg,
    east: east + paddingDeg,
    north: north + paddingDeg,
  };
}

/** Check whether a point lies within a bounding box. */
export function isPointInBBox(point: LngLat, bbox: BoundingBox): boolean {
  return (
    point[0] >= bbox.west &&
    point[0] <= bbox.east &&
    point[1] >= bbox.south &&
    point[1] <= bbox.north
  );
}
