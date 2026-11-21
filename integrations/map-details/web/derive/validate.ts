/**
 * Range checks for typed tileset attributes. Planetiler parses numbers
 * leniently ("3.5 m" → 3.5, "12'" → 12, "12,5" possibly 125), so every number
 * the client uses passes through here first (spec §5.1).
 */

type Raw = string | number | boolean | undefined | null;

function inRange(value: Raw, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

export const roadWidth = (value: Raw) => inRange(value, 2, 40);
export const treeHeight = (value: Raw) => inRange(value, 2, 45);
export const treeCrown = (value: Raw) => inRange(value, 1, 30);
export const treeCirc = (value: Raw) => inRange(value, 0.1, 8);

export function laneCount(value: Raw): number | null {
  const count = inRange(value, 1, 8);
  return count !== null && Number.isInteger(count) ? count : null;
}

const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/** A direction in degrees clockwise from north, from degrees or a 16-point compass name. */
export function direction(value: Raw): number | null {
  if (typeof value === "number") return inRange(value, 0, 360);
  if (typeof value !== "string") return null;
  const text = value.trim();
  const index = COMPASS.indexOf(text.toUpperCase());
  if (index >= 0) return index * 22.5;
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return inRange(Number(text), 0, 360);
}

export function signalDirection(value: Raw): "forward" | "backward" | "both" {
  return value === "forward" || value === "backward" ? value : "both";
}

/** A `|`-separated per-lane list, or null unless its length equals the lane count. */
export function laneList(value: Raw, count: number | null): string[] | null {
  if (typeof value !== "string" || value === "" || count === null) return null;
  const lanes = value.split("|").map((lane) => lane.trim());
  return lanes.length === count ? lanes : null;
}

export function firstSport(value: Raw): string | null {
  if (typeof value !== "string") return null;
  const sport = value.split(";")[0]?.trim() ?? "";
  return sport === "" ? null : sport;
}
