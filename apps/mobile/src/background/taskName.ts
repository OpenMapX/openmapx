/**
 * The one and only background location task name.
 *
 * Everything — task definition, driver start, driver stop, "is it running"
 * checks — goes through this constant. Two names would mean two streams, which
 * is the single failure this architecture most needs to prevent.
 */
export const NAVIGATION_LOCATION_TASK = "openmapx-navigation-location";
