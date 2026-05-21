/**
 * Shared in-memory loader and query API for the OurAirports dataset.
 *
 * Loaded once per Node.js process (module-scoped state in `loader.ts`), so
 * every integration that imports from this package — currently
 * `knowledge-ourairports` and `overlay-ourairports` — shares the same parsed
 * catalog. The actual CSV fetches use conditional GET so an unchanged daily
 * dump returns 304 and we reuse the previously-parsed body.
 */
export { type CsvRecord, parseCsv, parseOptionalFloat, parseOptionalInt } from "./csv.js";
export { type DataStore, getStore, startBackgroundLoad, stopBackgroundLoad } from "./loader.js";
export { buildSearchIndex, type SearchIndex } from "./search.js";
export {
  type BboxQueryOptions,
  haversineKm,
  lookupAirport,
  lookupAirportRecord,
  lookupNearestAerodrome,
  queryAirportsInBbox,
  searchAirports,
} from "./spatial.js";
export type { AirportRecord } from "./types.js";
