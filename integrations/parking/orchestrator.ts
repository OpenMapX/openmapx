import {
  createSiteOrchestrator,
  type IntegrationContext,
  type ParkingSite,
  type ParkingSiteProvider,
  type ParkingSiteQuery,
  type SiteOrchestrator,
} from "@openmapx/integration-framework";

/**
 * Every parking-site provider (domain `parking-sites`) merged behind one
 * search and one read by id; see `createSiteOrchestrator`.
 */
export function createParkingSiteOrchestrator(
  ctx: IntegrationContext,
): SiteOrchestrator<ParkingSiteProvider, ParkingSite, ParkingSiteQuery> {
  return createSiteOrchestrator<ParkingSiteProvider, ParkingSite, ParkingSiteQuery>(ctx, {
    domain: "parking-sites",
    logPrefix: "parking",
    search: { name: "searchSites", run: (p, bbox, query) => p.searchSites(bbox, query) },
    get: { name: "getSite", run: (p, id, query) => p.getSite(id, query) },
  });
}
