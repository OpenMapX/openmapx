/**
 * The legs a trip's summary chain names: its rides. The walking between them
 * is given as a distance beside the chain; a trip that is all walking keeps its walk.
 */
export function summaryChainLegs<T extends { mode: string }>(legs: readonly T[]): readonly T[] {
  const rides = legs.filter((leg) => leg.mode !== "walking");
  return rides.length > 0 ? rides : legs;
}
