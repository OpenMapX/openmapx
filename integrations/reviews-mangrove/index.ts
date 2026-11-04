import { dataSourceToAttribution, type IntegrationContext } from "@openmapx/integration-framework";
import { createMangroveProvider } from "./provider.js";
import { registerSignerRoutes } from "./signer.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerReviewProvider(
    createMangroveProvider(() => {
      const source = ctx.manifest.dataSources?.find(({ sourceId }) => sourceId === "mangrove");
      return source && dataSourceToAttribution(source);
    }),
  );
  registerSignerRoutes(ctx);
}
