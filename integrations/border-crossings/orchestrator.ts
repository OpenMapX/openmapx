import {
  type BorderCrossing,
  type BorderCrossingProvider,
  type BorderCrossingQuery,
  createSiteOrchestrator,
  type IntegrationContext,
  type SiteOrchestrator,
} from "@openmapx/integration-framework";

/**
 * Every border-crossing provider (domain `border-crossings`) merged behind
 * one search and one read by id; see `createSiteOrchestrator`.
 */
export function createBorderCrossingOrchestrator(
  ctx: IntegrationContext,
): SiteOrchestrator<BorderCrossingProvider, BorderCrossing, BorderCrossingQuery> {
  return createSiteOrchestrator<BorderCrossingProvider, BorderCrossing, BorderCrossingQuery>(ctx, {
    domain: "border-crossings",
    logPrefix: "border-crossings",
    search: {
      name: "searchCrossings",
      run: async (p, bbox, query) => {
        const { crossings, partial } = await p.searchCrossings(bbox, query);
        return partial ? { sites: crossings, partial } : { sites: crossings };
      },
    },
    get: { name: "getCrossing", run: (p, id, query) => p.getCrossing(id, query) },
  });
}
