import { buildSemanticCategoryCatalog } from "@openmapx/presets";
import {
  CURATED_SEMANTIC_TAXONOMY_CASES_V1,
  type SemanticTaxonomyCaseV1,
} from "./fixtures/corpus-v1.js";

export type { SemanticNegativeFamily, SemanticTaxonomyCaseV1 } from "./fixtures/corpus-v1.js";

export const GENERATED_DIRECT_SMOKE_CASES: readonly SemanticTaxonomyCaseV1[] = Object.freeze(
  buildSemanticCategoryCatalog().flatMap((category) =>
    (["en", "de"] as const).map((lang) =>
      Object.freeze({
        id: `direct:${category.categoryId}:${lang}`,
        query: category.labels[lang],
        lang,
        split: "development" as const,
        expected: {
          status: "category" as const,
          acceptableCategoryIds: [category.categoryId],
        },
        strata: {
          kind: "direct" as const,
          categoryFamily: category.categoryId,
          conceptFamily: `direct:${category.categoryId}`,
          p0: false,
        },
        evidence: "Generated direct-label smoke case for catalog/model integrity only.",
      }),
    ),
  ),
);

export const SEMANTIC_TAXONOMY_CASES = CURATED_SEMANTIC_TAXONOMY_CASES_V1;
