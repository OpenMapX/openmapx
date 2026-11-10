/** Saved places one account may hold across all of its lists. */
export const MAX_SAVED_PLACES_PER_USER = 50_000;
/** Saved lists one account may hold, including the system lists. */
export const MAX_SAVED_LISTS_PER_USER = 500;

/** Only these persisted names identify protected, translated system lists. */
export function isSystemSavedList(name: string): boolean {
  return name === "$favorites" || name === "$wantToGo" || name === "$starredPlaces";
}
