import type { IntegrationContext } from "@openmapx/integration-framework";

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/ping", async (_req, reply) => {
    reply.send({ integration: "gamma" });
  });
}
