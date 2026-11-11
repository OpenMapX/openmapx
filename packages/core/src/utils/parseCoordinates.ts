import type { LngLat } from "../types/geometry";

type Axis = "lat" | "lng";

interface CoordinateReading {
  value: number;
  axis: Axis | null;
}

// A number with its optional degree sign, or one hemisphere letter.
const ITEM = /(-?\d+(?:\.\d+)?)(?:\s*°)?|([NSEW])/gi;

type Item = { number: string } | { letter: string };

/** One number with at most one hemisphere letter; a letter and a minus sign contradict each other. */
function readCoordinate(letter: string | undefined, number: string): CoordinateReading | null {
  const value = Number.parseFloat(number);
  if (!letter) return { value, axis: null };
  if (number.startsWith("-")) return null;
  const hemisphere = letter.toUpperCase();
  const negative = hemisphere === "S" || hemisphere === "W";
  return {
    value: negative ? -value : value,
    axis: hemisphere === "N" || hemisphere === "S" ? "lat" : "lng",
  };
}

/** Which number is the latitude, from the letters the two readings carry, or null when they conflict. */
function placeReadings(
  first: CoordinateReading,
  second: CoordinateReading,
): { lat: number; lng: number } | null {
  if (first.axis === null && second.axis === null) return { lat: first.value, lng: second.value };
  if (first.axis !== null && first.axis === second.axis) return null;
  const firstIsLat = first.axis === "lat" || second.axis === "lng";
  return firstIsLat
    ? { lat: first.value, lng: second.value }
    : { lat: second.value, lng: first.value };
}

/** The numbers and hemisphere letters of an input in order, or null when it holds anything else. */
function scanItems(input: string): Item[] | null {
  const items: Item[] = [];
  let end = 0;
  for (const match of input.matchAll(ITEM)) {
    const start = match.index ?? 0;
    if (input.slice(end, start).trim() !== "") return null;
    const previous = items[items.length - 1];
    if (match[1] && previous && "number" in previous && start === end) return null;
    items.push(match[1] ? { number: match[1] } : { letter: match[2] });
    end = start + match[0].length;
  }
  return input.slice(end).trim() === "" ? items : null;
}

const HALF = /^(?:([NSEW])\s*)?(-?\d+(?:\.\d+)?)\s*(?:°\s*)?([NSEW])?$/i;

/** One comma-separated half, for example "N51.39", "51.39°N" or "6.75"; a letter on both sides is refused. */
function readHalf(half: string): CoordinateReading | null {
  const match = half.trim().match(HALF);
  if (!match || (match[1] && match[3])) return null;
  return readCoordinate(match[1] ?? match[3], match[2]);
}

/**
 * Every way to split a space-separated input into two coordinates. A letter
 * between the numbers may belong to either side, so such input has several
 * readings.
 */
function readSpaced(items: Item[]): { lat: number; lng: number }[] {
  const numberIndexes = items.flatMap((item, index) => ("number" in item ? [index] : []));
  if (numberIndexes.length !== 2) return [];
  const [firstAt, secondAt] = numberIndexes;
  const letters = (list: Item[]) => list.flatMap((item) => ("letter" in item ? [item.letter] : []));
  const before = letters(items.slice(0, firstAt));
  const between = letters(items.slice(firstAt + 1, secondAt));
  const after = letters(items.slice(secondAt + 1));
  const first = items[firstAt] as { number: string };
  const second = items[secondAt] as { number: string };

  const readings: { lat: number; lng: number }[] = [];
  for (let split = 0; split <= between.length; split++) {
    const firstLetters = [...before, ...between.slice(0, split)];
    const secondLetters = [...between.slice(split), ...after];
    if (firstLetters.length > 1 || secondLetters.length > 1) continue;
    const a = readCoordinate(firstLetters[0], first.number);
    const b = readCoordinate(secondLetters[0], second.number);
    const placed = a && b ? placeReadings(a, b) : null;
    if (placed) readings.push(placed);
  }
  return readings;
}

const MAX_INPUT_LENGTH = 200;

/**
 * Attempts to parse user input as decimal-degree coordinates.
 * Supports:
 *   "51.396216, 6.758663"    — lat/lng with comma
 *   "51.396216 6.758663"     — lat/lng with space
 *   "51.396216N 6.758663E"   — with N/S/E/W suffixes
 *   "N51.396216, E6.758663"  — with N/S/E/W prefixes
 *   "E6.758663, N51.396216"  — hemisphere letters in either order
 *   "-33.8688, 151.2093"     — negative values
 * Without hemisphere letters the first number is the latitude. With them the
 * letters decide which number is which. Input is refused when its letters name
 * the same axis twice, when a letter sits beside a minus sign, when a value is out
 * of range, or when a lone letter between two numbers could belong to either and
 * the two readings differ.
 */
export function parseCoordinateInput(input: string): { lngLat: LngLat; label: string } | null {
  // Coordinate input is short; refusing long text keeps parsing cheap.
  if (input.length > MAX_INPUT_LENGTH) return null;
  // A comma left at the end, as when the pair is pasted from a list, is not a separator.
  let trimmed = input.trim();
  if (trimmed.endsWith(",")) trimmed = trimmed.slice(0, -1).trimEnd();
  if (!trimmed) return null;

  const halves = trimmed.split(",");
  let placed: { lat: number; lng: number } | null = null;
  if (halves.length === 2) {
    const first = readHalf(halves[0]);
    const second = readHalf(halves[1]);
    placed = first && second ? placeReadings(first, second) : null;
  } else if (halves.length === 1) {
    const items = scanItems(trimmed);
    const readings = items ? readSpaced(items) : [];
    const [only] = readings;
    if (only && readings.every((r) => r.lat === only.lat && r.lng === only.lng)) placed = only;
  }
  if (!placed) return null;

  const { lat, lng } = placed;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lngLat: [lng, lat], label: `${lat}, ${lng}` };
}

/**
 * Attempts to parse degrees-minutes-seconds (DMS) coordinates.
 * Supports: "51°23'46.4\"N 6°45'31.9\"E"
 */
export function parseDMSCoordinateInput(input: string): { lngLat: LngLat; label: string } | null {
  const trimmed = input.trim();
  const dmsRegex =
    /^(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*["″]?\s*([NSns])\s*[,\s]+\s*(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*["″]?\s*([EWew])$/;
  const m = trimmed.match(dmsRegex);
  if (!m) return null;

  let lat = parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600;
  let lng = parseFloat(m[5]) + parseFloat(m[6]) / 60 + parseFloat(m[7]) / 3600;
  if (m[4].toUpperCase() === "S") lat = -lat;
  if (m[8].toUpperCase() === "W") lng = -lng;

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const fmt = (n: number) => n.toFixed(6).replace(/\.?0+$/, "");
  return { lngLat: [lng, lat], label: `${fmt(lat)}, ${fmt(lng)}` };
}
