export const STATION_ID_PREFIX = "s:";
export const VEHICLE_ID_PREFIX = "v:";

export function stripMobilityKindPrefix(id: string): string {
  if (id.startsWith(STATION_ID_PREFIX)) return id.slice(STATION_ID_PREFIX.length);
  if (id.startsWith(VEHICLE_ID_PREFIX)) return id.slice(VEHICLE_ID_PREFIX.length);
  return id;
}
