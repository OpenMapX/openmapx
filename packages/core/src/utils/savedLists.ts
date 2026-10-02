/** Only these persisted names identify protected, translated system lists. */
export function isSystemSavedList(name: string): boolean {
  return name === "$favorites" || name === "$wantToGo" || name === "$starredPlaces";
}
