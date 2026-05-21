/**
 * Shared MDAPI catalog + Data API client for NOAA CO-OPS.
 *
 * Used by `knowledge-noaa-tides` (place-panel tide widget) and
 * `overlay-noaa-stations` (clustered station map layer). The MDAPI station
 * catalog is cached in Redis for 7 days; Data API responses (predictions,
 * water-level observations, met readings) are cached per-route by the
 * consuming integration.
 */
export {
  fetchHighLowPredictions,
  fetchLatestMet,
  fetchLatestWaterLevel,
  fetchTideCurve,
} from "./datagetter.js";
export {
  type BboxQuery,
  findNearestStation,
  findStationById,
  haversineKm,
  loadStations,
  type NearestStation,
  queryStationsInBbox,
} from "./stations.js";
export type {
  MetReadings,
  NoaaStation,
  NoaaStationType,
  TideEvent,
  WaterLevelReading,
} from "./types.js";
