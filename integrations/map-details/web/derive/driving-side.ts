import { LEFT_HAND_TRAFFIC_REGIONS } from "./driving-side-regions";

interface Region {
  ring: readonly number[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

let regions: Region[] | null = null;

/** Decode an encoded polyline into a flat [x, y, …] ring in hundredths of a degree. */
export function decodeRing(encoded: string): number[] {
  const out: number[] = [];
  let index = 0;
  let x = 0;
  let y = 0;
  const next = () => {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    x += next();
    y += next();
    out.push(x, y);
  }
  return out;
}

function loadRegions(): Region[] {
  regions ??= LEFT_HAND_TRAFFIC_REGIONS.map((encoded) => {
    const ring = decodeRing(encoded);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i] as number);
      maxX = Math.max(maxX, ring[i] as number);
      minY = Math.min(minY, ring[i + 1] as number);
      maxY = Math.max(maxY, ring[i + 1] as number);
    }
    return { ring, minX, minY, maxX, maxY };
  });
  return regions;
}

function inside(x: number, y: number, ring: readonly number[]): boolean {
  let result = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i] as number;
    const yi = ring[2 * i + 1] as number;
    const xj = ring[2 * j] as number;
    const yj = ring[2 * j + 1] as number;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

/** Whether traffic keeps left at a point (simplified Natural Earth regions; spec §5.10). */
export function isLeftHandTraffic(lng: number, lat: number): boolean {
  const x = lng * 100;
  const y = lat * 100;
  return loadRegions().some(
    (region) =>
      x >= region.minX &&
      x <= region.maxX &&
      y >= region.minY &&
      y <= region.maxY &&
      inside(x, y, region.ring),
  );
}
