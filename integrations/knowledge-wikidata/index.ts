import {
  type IntegrationContext,
  resolveIntegrationContributors,
  withKnowledgeContributors,
} from "@openmapx/integration-framework";
import { wikidataSource } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  ctx.registerKnowledgeProvider(
    withKnowledgeContributors(wikidataSource, () => {
      const uniform = resolveIntegrationContributors(ctx, ["wikidata"]);
      return {
        uniform,
        overrides: {
          wikipediaExtract: resolveIntegrationContributors(ctx, ["wikidata", "wikipedia"]),
        },
      };
    }),
  );
}
