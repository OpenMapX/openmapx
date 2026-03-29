/**
 * Server-safe exports from @openmapx/core.
 * Use `import { ... } from "@openmapx/core/server"` in React Server Components
 * to avoid pulling in client-only hooks via the barrel export.
 */

export { fetchCapabilities, isServiceAvailable } from "./api/capabilities";
export { categoryPlaceToPlace } from "./types/category";
export { applyHoursFilter } from "./utils/categoryFilter";
export { formatAddress, legalConfig } from "./utils/legalConfig";
export { sectionSlug } from "./utils/sectionSlug";
