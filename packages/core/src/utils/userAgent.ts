/**
 * Centralised user-agent strings for all outbound HTTP requests.
 *
 * Many third-party APIs (Nominatim, OSRM, Transitous, Met.no, OSM tiles, …)
 * require a meaningful User-Agent. Keeping them in one place makes it easy to
 * bump the version or change the contact URL project-wide.
 */

const APP_NAME = "OpenMapX";
const APP_VERSION = "1.0";
const APP_URL = "https://github.com/openmapx";

/** Default user-agent — suitable for most API calls. */
export const USER_AGENT = `${APP_NAME}/${APP_VERSION} (${APP_URL})`;

/**
 * User-agent with an explicit contact email — required by some transit APIs
 * (Transitous, iRail, GTFS catalogs).
 */
export const USER_AGENT_TRANSIT = `${APP_NAME}/${APP_VERSION} (transit@openmapx.org)`;

/**
 * User-agent for admin / internal tooling requests.
 */
export const USER_AGENT_ADMIN = `${APP_NAME}-Admin/${APP_VERSION}`;

/**
 * Build a custom user-agent that keeps the `OpenMapX/<version>` prefix.
 *
 * @example userAgent("weather@openmapx.org")  // "OpenMapX/1.0 (weather@openmapx.org)"
 * @example userAgent("+https://openmapx.org") // "OpenMapX/1.0 (+https://openmapx.org)"
 */
export function userAgent(comment: string): string {
  return `${APP_NAME}/${APP_VERSION} (${comment})`;
}
