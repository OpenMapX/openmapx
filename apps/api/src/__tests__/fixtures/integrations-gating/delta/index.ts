import type { IntegrationContext } from "@openmapx/integration-framework";

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/disallowed", async (_req, reply) => {
    const sources = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
    const integrations = (await ctx.getDisallowedIntegrationIds?.()) ?? new Set<string>();
    reply.send({
      sources: [...sources].sort(),
      integrations: [...integrations].sort(),
    });
  });
}
