export type DataSourceContextAction =
  | { type: "none" }
  | { type: "select-station"; stationId: string }
  | { type: "inspect"; properties: Record<string, unknown> };

/** Marker hits always win when markers and context polygons overlap. */
export function pickDataSourceContextAction(
  markerHitCount: number,
  properties: Record<string, unknown> | null | undefined,
): DataSourceContextAction {
  if (markerHitCount > 0 || !properties) return { type: "none" };
  if (properties.contextKind === "station_area" && typeof properties.stationId === "string") {
    return { type: "select-station", stationId: properties.stationId };
  }
  return { type: "inspect", properties };
}
