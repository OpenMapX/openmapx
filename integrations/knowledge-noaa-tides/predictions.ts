/**
 * Re-exports for callers that imported the predictions API at its legacy path.
 * The implementation now lives in `@openmapx/noaa-coops-data`.
 */
export { fetchHighLowPredictions, type TideEvent } from "@openmapx/noaa-coops-data";
