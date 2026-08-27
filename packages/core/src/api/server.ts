/**
 * Narrow server-side HTTP helpers for web server components.
 *
 * Keep this entry point separate from the broad Node-only `./server` barrel:
 * importing that barrel into Next makes its filesystem/service-management
 * graph part of output tracing even when a page only needs an HTTP helper.
 */
export { fetchCapabilities, isServiceAvailable } from "./capabilities";
export {
  type AiCloudProcessor,
  type AiSearchDisclosure,
  type Disclosure,
  fetchDisclosures,
  fetchIntegrations,
} from "./integrations";
export { fetchLegalConfig, type PublicLegalConfig } from "./legal-config";
export { serverApiUrl } from "./server-url";
