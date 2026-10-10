import {
  type ChargingSite,
  type ChargingSiteProvider,
  type ChargingSiteQuery,
  createSiteOrchestrator,
  type IntegrationContext,
  type SiteOrchestrator,
} from "@openmapx/integration-framework";

/**
 * Every charging-site provider (domain `charging-sites`) merged behind one
 * search and one read by id; see `createSiteOrchestrator`.
 */
export function createChargingSiteOrchestrator(
  ctx: IntegrationContext,
): SiteOrchestrator<ChargingSiteProvider, ChargingSite, ChargingSiteQuery> {
  return createSiteOrchestrator<ChargingSiteProvider, ChargingSite, ChargingSiteQuery>(ctx, {
    domain: "charging-sites",
    logPrefix: "ev-charging",
    search: { name: "searchSites", run: (p, bbox, query) => p.searchSites(bbox, query) },
    get: { name: "getSite", run: (p, id, query) => p.getSite(id, query) },
  });
}
