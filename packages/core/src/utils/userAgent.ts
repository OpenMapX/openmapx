/**
 * Centralised user-agent strings for all outbound HTTP requests.
 *
 * Many third-party APIs (Nominatim, OSRM, Transitous, Met.no, OSM tiles, …)
 * require a meaningful User-Agent. Keeping them in one place makes it easy to
 * bump the version or change the contact domain project-wide.
 */

const APP_NAME = "OpenMapX";
const APP_VERSION = "1.0";
const APP_URL = "https://github.com/openmapx";

/**
 * Contact domain embedded in outbound User-Agent strings (and the API's email
 * `From` fallback). Resolves to the deployment's configured `DOMAIN`, so the
 * contact a third party sees matches the site that's actually calling them.
 *
 * Falls back to the canonical project domain only as a last resort: browser
 * bundles (where `process.env.DOMAIN` is statically `undefined`) and any
 * service started without `DOMAIN`. `localhost` (the dev manifest default) is
 * treated as unset so dev builds don't advertise a useless `@localhost` contact
 * to APIs that require a real one. Mirrors the resolution in
 * `apps/api/src/routes/maptiler.ts`.
 */
export function contactDomain(): string {
  const domain = process.env.DOMAIN?.trim();
  return domain && domain !== "localhost" ? domain : "openmapx.org";
}

const CONTACT_DOMAIN = contactDomain();

/** Default user-agent — suitable for most API calls. */
export const USER_AGENT = `${APP_NAME}/${APP_VERSION} (${APP_URL})`;

/**
 * User-agent with an explicit contact email — required by some transit APIs
 * (Transitous, iRail, GTFS catalogs). The contact domain follows the
 * deployment's `DOMAIN` (see {@link contactDomain}).
 */
export const USER_AGENT_TRANSIT = `${APP_NAME}/${APP_VERSION} (transit@${CONTACT_DOMAIN})`;

/**
 * User-agent with a contact URL — the form Nominatim / Wikidata-style endpoints
 * expect. The contact domain follows the deployment's `DOMAIN`.
 */
export const USER_AGENT_CONTACT = `${APP_NAME}/${APP_VERSION} (+https://${CONTACT_DOMAIN})`;

/**
 * User-agent for admin / internal tooling requests.
 */
export const USER_AGENT_ADMIN = `${APP_NAME}-Admin/${APP_VERSION}`;

/**
 * Build a custom user-agent that keeps the `OpenMapX/<version>` prefix. Prefer
 * deriving the contact from {@link contactDomain} so it tracks the deployment.
 *
 * @example userAgent(`weather@${contactDomain()}`) // "OpenMapX/1.0 (weather@<DOMAIN>)"
 * @example userAgent("admin@example.com")          // "OpenMapX/1.0 (admin@example.com)"
 */
export function userAgent(comment: string): string {
  return `${APP_NAME}/${APP_VERSION} (${comment})`;
}
