export type {
  GtfsDepartureRow,
  GtfsDeps,
  GtfsStopRow,
} from "@integrations/transit-gtfs-local/gtfs-local";
export {
  getArrivals,
  getDepartures,
  getPlatformStops,
  getStopById,
  getStops,
  getTimetable,
  hasCoverage,
  isGtfsLocalId,
  searchByName,
  setDeps,
} from "@integrations/transit-gtfs-local/gtfs-local";
