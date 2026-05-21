/**
 * The in-memory loader and lookup helpers live in `@openmapx/ourairports-data`
 * so multiple integrations (knowledge, overlay, …) can share a single parsed
 * catalog. Re-exported here for backward compatibility with the integration's
 * existing test suite and direct consumers.
 */
export {
  lookupAirport,
  lookupNearestAerodrome,
  startBackgroundLoad,
  stopBackgroundLoad,
} from "@openmapx/ourairports-data";
