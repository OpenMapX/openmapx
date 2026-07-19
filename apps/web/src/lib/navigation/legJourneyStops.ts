/**
 * Slice a full vehicle journey's stop list down to the segment a single leg
 * rides — from the board stop to the alight stop. For circular routes
 * (Ringlinien) a stop id can appear more than once, so the alight stop is always
 * matched *after* the board stop. Falls back to the whole list when the
 * endpoints can't be located. Generic over any stop-like item carrying `stopId`.
 */
export function sliceJourneyToLeg<T extends { stopId: string }>(
  stops: T[],
  fromStopId?: string,
  toStopId?: string,
): T[] {
  const fromIdx = fromStopId ? stops.findIndex((s) => s.stopId === fromStopId) : -1;
  const toIdx =
    fromIdx !== -1 && toStopId
      ? stops.findIndex((s, i) => i > fromIdx && s.stopId === toStopId)
      : toStopId
        ? stops.findIndex((s) => s.stopId === toStopId)
        : -1;
  return fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx
    ? stops.slice(fromIdx, toIdx + 1)
    : stops;
}
