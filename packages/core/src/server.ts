/**
 * Server-safe exports from @openmapx/core.
 *
 * These re-exports pull in Node-only modules (`node:fs`, `node:child_process`,
 * `node:path`, …) and therefore cannot live in the main `./index.ts` barrel —
 * Next.js / Turbopack refuses to bundle `node:*` imports into the client
 * chunk, even when the importing component never reaches the server-only
 * symbols at runtime (the module graph is walked eagerly). Apps that need
 * these symbols must import them from `@openmapx/core/server` instead:
 *
 *   ```ts
 *   import { repoPaths, services, gitShallowClone } from "@openmapx/core/server";
 *   ```
 */

export { fetchCapabilities, isServiceAvailable } from "./api/capabilities";
export {
  type AiCloudProcessor,
  type AiSearchDisclosure,
  type Disclosure,
  fetchDisclosures,
  fetchIntegrations,
} from "./api/integrations";
export { fetchLegalConfig, type PublicLegalConfig } from "./api/legal-config";
export { serverApiUrl } from "./api/server-url";
// Git clone helpers (shared by community service repos + community integrations)
export {
  assertCloneWithinBudget,
  assertGitTreeMetadataWithinBudget,
  GIT_CLONE_MAX_ENTRIES,
  GIT_CLONE_MAX_FILE_BYTES,
  GIT_CLONE_MAX_PATH_BYTES,
  GIT_CLONE_MAX_TOTAL_BYTES,
  GIT_CLONE_TIMEOUT_MS,
  GitCloneQuotaError,
  type GitShallowCloneOptions,
  type GitShallowCloneResult,
  gitShallowClone,
  gitShallowCloneSnapshot,
} from "./git-clone";
// Git URL validation (allow-list for community integration / service repo installs)
export {
  ALLOWED_GIT_HOSTS,
  type AllowedGitUrl,
  assertAllowedGitUrl,
  canonicalGitUrl,
  InvalidGitUrlError,
} from "./git-url";
export {
  assertPosixProcessGroupsSupported,
  monitorPosixProcessGroup,
  type PosixProcessGroupChild,
  type PosixProcessGroupExit,
  type PosixProcessGroupLifecycle,
} from "./posix-process-group";
// Repo path resolution (shared by CLI + apps/api runtime code)
export { findRepoRoot, type RepoPaths, repoPaths } from "./repo-paths";
// Service plugin system (manifest loader, compose renderer — all uses node:fs)
export * as services from "./services";
// Subprocess helper used by git-clone and the community-integration build step
export {
  redactProcessOutput,
  type SpawnWithBufferedLogsOptions,
  spawnWithBufferedLogs,
} from "./spawn";
export { categoryPlaceToPlace } from "./types/category";
// Shared food-delivery wire contract (also re-exported from the client barrel).
export type { DeliveryLinkKind, DeliveryProviderInfo } from "./types/delivery";
export type { HotelOffer, HotelOffersResponse, HotelProviderInfo } from "./types/hotel";
export type { Identified, Ids } from "./types/identified";
export { makeId, parseId, withId } from "./types/identified";
export type { Place, PlaceFact, PlaceIds, PlacePhoto, PlaceReviewLink } from "./types/place";
export {
  coordinateId,
  createPlace,
  idsFromPrimary,
  idsFromPrimaryOrCoords,
} from "./types/placeIds";
export {
  buildAttributionHtml,
  buildIntegrationAttribution,
  combineAttributions,
} from "./utils/attribution";
export {
  type BoundedBinaryProxy,
  type BoundedBinaryResponseOptions,
  createBoundedBinaryProxyStream,
  MAX_RASTER_TILE_BYTES,
  MAX_VECTOR_TILE_BYTES,
  RASTER_IMAGE_MEDIA_TYPES,
  readBoundedBinaryResponse,
  VECTOR_TILE_MEDIA_TYPES,
} from "./utils/boundedBinaryResponse";
export { applyHoursFilter } from "./utils/categoryFilter";
export {
  DELIVERY_PROVIDER_HOSTS,
  deliveryProviderIdForHost,
} from "./utils/deliveryProviderHosts";
export {
  createFatalProcessHandler,
  type FatalProcessPorts,
} from "./utils/fatalProcessPolicy";
// Server-side geo helpers (great-circle distance, etc.).
export { haversineKm } from "./utils/geo-server";
export { bareDomain, toHttpUrl } from "./utils/httpUrl";
export { formatAddress, legalConfig } from "./utils/legalConfig";
// Server-only opening-hours runtime (imports the LGPL-3 `opening_hours`
// package). Web code never touches this barrel — see `../utils/openingHours`
// for details on why this is kept out of the main client-facing index.
export {
  buildOpeningHoursInfo,
  isAlwaysOpen,
  isOpenAt,
  parseOpeningHours,
} from "./utils/openingHours";
// Safe downloader (DNS-aware SSRF protection for server-side fetches).
export {
  assertResolvesToPublicIp,
  type SafeDownloadOptions,
  type SafeDownloadResult,
  SafeFetchHttpError,
  type SafeFetchJsonOptions,
  type SafeJsonResponse,
  safeDownload,
  safeFetchJson,
  safeFetchJsonResponse,
  safeFetchText,
} from "./utils/safe-download";
export { sectionSlug } from "./utils/sectionSlug";
