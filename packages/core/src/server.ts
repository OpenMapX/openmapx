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
 *   import { repoPaths, services, gitShallowCloneAtomic } from "@openmapx/core/server";
 *   ```
 */

export { categoryPlaceToPlace } from "@integrations/poi-search/types";
export { fetchCapabilities, isServiceAvailable } from "./api/capabilities";
export { fetchIntegrations } from "./api/integrations";
export { serverApiUrl } from "./api/server-url";
// Git clone helpers (shared by community service repos + community integrations)
export {
  type GitShallowCloneOptions,
  gitShallowClone,
  gitShallowCloneAtomic,
} from "./git-clone";
export type { IdSchemeView, PlaceResolver, PlaceResolverContext } from "./ids";
export {
  buildFacebookUrl,
  buildFoursquareUrl,
  buildGoogleMapsUrl,
  buildInstagramUrl,
  buildTripadvisorUrl,
  buildYelpUrl,
  getIdSchemeView,
  getPlaceResolver,
  listIdSchemeViews,
  listPlaceResolverSchemes,
  registerBuiltinIdSchemeViews,
  registerIdSchemeView,
  registerPlaceResolver,
} from "./ids";
// Integration installer (community integration lifecycle). Imported directly
// from the implementation file — the `./integration` barrel would transitively
// load its sibling re-exports, some of which are safe to surface from the
// main core barrel and live there.
export {
  type BuildOptions as IntegrationBuildOptions,
  type BuildResult as IntegrationBuildResult,
  buildIntegration,
  type InstallOptions as IntegrationInstallOptions,
  type InstallResult as IntegrationInstallResult,
  type IntegrationSummary,
  installIntegration,
  type ListOptions as IntegrationListOptions,
  listIntegrations,
  type RemoveOptions as IntegrationRemoveOptions,
  removeIntegration,
  type ValidateResult as IntegrationValidateResult,
  validateIntegrationDirectory,
} from "./integration/installer";
// Repo path resolution (shared by CLI + apps/api runtime code)
export { findRepoRoot, type RepoPaths, repoPaths } from "./repo-paths";
// Service plugin system (manifest loader, compose renderer — all uses node:fs)
export * as services from "./services";
export { getChipTranslations, getPresetById, suggestPresets } from "./services/presets";
export type { ChipTranslation } from "./services/presets/chip-translations";
export type { PresetMatch } from "./services/presets/types";
// Subprocess helper used by git-clone and the community-integration build step
export { type SpawnWithBufferedLogsOptions, spawnWithBufferedLogs } from "./spawn";
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
export { applyHoursFilter } from "./utils/categoryFilter";
export { formatAddress, legalConfig } from "./utils/legalConfig";
// Safe downloader (DNS-aware SSRF protection for server-side fetches).
export {
  assertResolvesToPublicIp,
  type SafeDownloadOptions,
  type SafeDownloadResult,
  safeDownload,
} from "./utils/safe-download";
export { sectionSlug } from "./utils/sectionSlug";
