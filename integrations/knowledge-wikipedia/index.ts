import {
  type IntegrationContext,
  resolveIntegrationContributors,
  withKnowledgeContributors,
} from "@openmapx/integration-framework";
import { wikipediaSource } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerKnowledgeProvider(
    withKnowledgeContributors(wikipediaSource, () => {
      const uniform = resolveIntegrationContributors(ctx, ["wikipedia"]);
      return { uniform };
    }),
  );
}
