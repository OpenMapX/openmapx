/**
 * Conservative display humanizer for OSM tag values that local mappers
 * tagged as machine identifiers instead of human-readable names (e.g.
 * `brand=cambio_stadtmobil` instead of `brand=Cambio Stadtmobil`).
 *
 * Triggers only when the value is BOTH all-lowercase AND contains an
 * underscore — that's the snake_case signature. Anything with capitals
 * (`iPhone`, `4Wash`, `BMW`), spaces, single lowercase words (`aldi`),
 * or non-ASCII characters is returned unchanged.
 *
 * Operates on display only; the raw OSM tag stays untouched in data.
 */
export function humanizeOsmTagValue(value: string): string {
  if (!value) return value;
  if (!/^[a-z0-9_]+$/.test(value)) return value;
  if (!value.includes("_")) return value;
  return value
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
