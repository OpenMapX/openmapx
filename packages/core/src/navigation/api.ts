// The network surface a native navigation session is allowed to reach.
//
// Kept out of the headless navigation barrel on purpose. The barrel's promise is
// that everything in it runs in a background callback with no browser and no
// network; these functions need one, and a caller reaching for them should have
// to say so. `mobile:bundle:check` proves the resulting graph is still
// headless-safe.
export {
  ApiClient,
  type ApiClientConfig,
  ApiClientError,
  ApiRequestAbortedError,
  type ApiRequestOptions,
  createApiClient,
  isApiClientError,
  isApiRequestAbortedError,
} from "../api/client";
export { type FetchDirectionsParams, fetchDirections } from "../api/directions";
