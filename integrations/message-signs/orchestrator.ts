import {
  createSiteOrchestrator,
  type IntegrationContext,
  type MessageSign,
  type MessageSignProvider,
  type MessageSignQuery,
  type SiteOrchestrator,
} from "@openmapx/integration-framework";

/**
 * Every message-sign provider (domain `message-signs`) merged behind one
 * search and one read by id; see `createSiteOrchestrator`.
 */
export function createMessageSignOrchestrator(
  ctx: IntegrationContext,
): SiteOrchestrator<MessageSignProvider, MessageSign, MessageSignQuery> {
  return createSiteOrchestrator<MessageSignProvider, MessageSign, MessageSignQuery>(ctx, {
    domain: "message-signs",
    logPrefix: "message-signs",
    search: {
      name: "searchSigns",
      run: async (p, bbox, query) => {
        const { signs, partial } = await p.searchSigns(bbox, query);
        return partial ? { sites: signs, partial } : { sites: signs };
      },
    },
    get: { name: "getSign", run: (p, id, query) => p.getSign(id, query) },
  });
}
