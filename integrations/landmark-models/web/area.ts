import { cellsForBounds } from "../cells";

type Box = [number, number, number, number];

const METRES_PER_DEGREE_LAT = 111_320;
/** An area of interest never needs more cells than this. */
const MAX_AREA_CELLS = 64;

/**
 * The part of the map worth loading models for: the viewport padded so models
 * just outside it are ready when the user pans, but cut at a distance from the
 * centre, because a pitched camera can see to the horizon.
 */
export function areaOfInterest(
  view: { center: [number, number]; bounds: Box },
  padRatio = 0.25,
  maxDistanceM = 3_000,
): Box {
  const [west, south, east, north] = view.bounds;
  const padX = (east - west) * padRatio;
  const padY = (north - south) * padRatio;
  const [lng, lat] = view.center;
  const dLat = maxDistanceM / METRES_PER_DEGREE_LAT;
  const dLng = maxDistanceM / (METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));
  return [
    Math.max(west - padX, lng - dLng),
    Math.max(south - padY, lat - dLat),
    Math.min(east + padX, lng + dLng),
    Math.min(north + padY, lat + dLat),
  ];
}

/** Occupied z12 cells (`x/y`) inside an area. */
export function cellsInArea(area: Box, occupied: ReadonlySet<string>): string[] {
  return cellsForBounds(area, MAX_AREA_CELLS).filter((cell) => occupied.has(cell));
}
