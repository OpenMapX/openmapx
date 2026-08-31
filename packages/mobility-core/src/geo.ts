import type { BoundingBox } from "./types/geometry.js";

const EARTH_RADIUS_M = 6_371_000;

export function bboxContains(bbox: BoundingBox, lat: number, lng: number): boolean {
  return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
}

function bigrams(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < value.length - 1; index++) {
    const bigram = value.slice(index, index + 2);
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  return counts;
}

export function diceSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  let intersection = 0;
  for (const [bigram, count] of leftBigrams) {
    intersection += Math.min(count, rightBigrams.get(bigram) ?? 0);
  }
  return (2 * intersection) / (left.length - 1 + (right.length - 1));
}

export function haversineMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const toRadians = Math.PI / 180;
  const latitudeDelta = (toLat - fromLat) * toRadians;
  const longitudeDelta = (toLng - fromLng) * toRadians;
  const arc =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLat * toRadians) * Math.cos(toLat * toRadians) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(arc));
}
