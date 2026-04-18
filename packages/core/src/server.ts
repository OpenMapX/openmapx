/**
 * Server-safe exports from @openmapx/core.
 * Use `import { ... } from "@openmapx/core/server"` in React Server Components
 * to avoid pulling in client-only hooks via the barrel export.
 */

export { categoryPlaceToPlace } from "@integrations/poi-search/types";
export { fetchCapabilities, isServiceAvailable } from "./api/capabilities";
export { fetchIntegrations } from "./api/integrations";
export type { IdSchemeView, PlaceResolver, PlaceResolverContext } from "./ids";
export {
  getIdSchemeView,
  getPlaceResolver,
  listIdSchemeViews,
  listPlaceResolverSchemes,
  registerBuiltinIdSchemeViews,
  registerIdSchemeView,
  registerPlaceResolver,
} from "./ids";
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
export { sectionSlug } from "./utils/sectionSlug";
