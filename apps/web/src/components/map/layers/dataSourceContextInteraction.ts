export type DataSourceContextAction =
  | { type: "none" }
  | { type: "select-station"; stationId: string }
  | { type: "inspect"; properties: Record<string, unknown> };

/**
 * What a click on a context zone does. Results drawn over a zone take the
 * click before it reaches the zone, through their higher interaction priority.
 */
export function pickDataSourceContextAction(
  properties: Record<string, unknown> | null | undefined,
): DataSourceContextAction {
  if (!properties) return { type: "none" };
  if (properties.contextKind === "station_area" && typeof properties.stationId === "string") {
    return { type: "select-station", stationId: properties.stationId };
  }
  return { type: "inspect", properties };
}
