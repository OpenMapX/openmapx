/**
 * The legs a trip's summary chain names: its rides. The walking between them
 * is given as a distance beside the chain; a trip that is all walking keeps its walk.
 */
export function summaryChainLegs<T extends { mode: string }>(legs: readonly T[]): readonly T[] {
  const rides = legs.filter((leg) => leg.mode !== "walking");
  return rides.length > 0 ? rides : legs;
}

/**
 * A trip place's name. The planner names its stops, but the trip's own start
 * and end are points it only calls "START" and "END"; those show the place the
 * rider chose instead.
 */
export function tripPlaceName(place: { stopId?: string; name: string }, chosen: string): string {
  return place.stopId ? place.name : chosen || place.name;
}
