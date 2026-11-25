import { MOBILE_PROTOCOL_HEADER, MOBILE_PROTOCOL_MAX } from "@openmapx/core/navigation";
import { type ApiClient, createApiClient, isApiClientError } from "@openmapx/core/navigation/api";

const PROTOCOL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [MOBILE_PROTOCOL_HEADER]: String(MOBILE_PROTOCOL_MAX),
});

/**
 * The client every native API request goes through: the compiled API origin,
 * no cookies, and the mobile protocol this build speaks.
 *
 * No WebView cookie, token or session travels with these requests. The car
 * and the headless navigation task need a road network and a timetable, not
 * an identity. The protocol header lets the server refuse a build it no longer
 * serves instead of answering in a shape the build cannot read.
 */
export function createNativeApiClient(apiOrigin: string): ApiClient {
  return createApiClient({
    baseUrl: apiOrigin,
    credentials: "omit",
    headerInterceptor: () => PROTOCOL_HEADERS,
  });
}

/**
 * The server no longer serves this build's protocol. Retrying cannot help;
 * only a store update can, so callers show "update required".
 */
export function isUpdateRequired(error: unknown): boolean {
  return isApiClientError(error) && error.status === 426;
}
