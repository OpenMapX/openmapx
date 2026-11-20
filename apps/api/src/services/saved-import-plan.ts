/** A saved place as the import planner compares it. */
interface PlacedName {
  name: string;
  lat: number;
  lng: number;
}

/** Grid cells are 1e-5° wide, so a duplicate is always in a place's cell or a neighbour. */
const DUPLICATE_DEGREES = 1e-5;

/**
 * Which incoming places to import into a list and at which sort order. A place
 * is a duplicate when the list, or an earlier place in the same batch, holds one
 * with the same name within 1e-5° in both latitude and longitude. Accepted places
 * are numbered after the list's highest order, in batch order.
 */
export function planSavedImport<T extends PlacedName>(
  existing: ReadonlyArray<PlacedName & { sortOrder: number }>,
  incoming: readonly T[],
): { accepted: Array<{ place: T; sortOrder: number }>; skippedDuplicates: number } {
  const cells = new Map<string, PlacedName[]>();
  const cellKey = (name: string, x: number, y: number) => JSON.stringify([name, x, y]);
  const remember = (place: PlacedName) => {
    const key = cellKey(
      place.name,
      Math.floor(place.lat / DUPLICATE_DEGREES),
      Math.floor(place.lng / DUPLICATE_DEGREES),
    );
    const cell = cells.get(key) || [];
    cell.push(place);
    cells.set(key, cell);
  };
  for (const place of existing) remember(place);
  let order = existing.reduce((max, place) => Math.max(max, place.sortOrder), -1);
  const accepted: Array<{ place: T; sortOrder: number }> = [];
  for (const place of incoming) {
    const x = Math.floor(place.lat / DUPLICATE_DEGREES);
    const y = Math.floor(place.lng / DUPLICATE_DEGREES);
    let duplicate = false;
    for (let dx = -1; dx <= 1 && !duplicate; dx++) {
      for (let dy = -1; dy <= 1 && !duplicate; dy++) {
        duplicate = (cells.get(cellKey(place.name, x + dx, y + dy)) || []).some(
          (other) =>
            Math.abs(other.lat - place.lat) <= DUPLICATE_DEGREES &&
            Math.abs(other.lng - place.lng) <= DUPLICATE_DEGREES,
        );
      }
    }
    if (duplicate) continue;
    remember(place);
    accepted.push({ place, sortOrder: ++order });
  }
  return { accepted, skippedDuplicates: incoming.length - accepted.length };
}

/**
 * The name to try for an imported list on attempt `suffix`: the base name
 * first, then "Name (2)", "Name (3)" and so on, kept within 200 characters
 * without splitting a surrogate pair.
 */
export function suffixedListName(base: string, suffix: number): string {
  const ending = suffix === 1 ? "" : ` (${suffix})`;
  return `${base.slice(0, 200 - ending.length).replace(/[\uD800-\uDBFF]$/, "")}${ending}`;
}
