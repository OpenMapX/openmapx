import { captureKnowledgeResult, type KnowledgeProvider } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { type FieldContributors, snapshotContributors } from "@openmapx/mobility-core/contributors";

/** Built-in adapter certificate; do not use a manifest's whole domain catalogue. */
export function withKnowledgeContributors(
  provider: KnowledgeProvider,
  capture: () => { uniform: readonly Attribution[]; overrides?: FieldContributors },
): KnowledgeProvider {
  return {
    ...provider,
    async lookup(...args) {
      const evidence = capture();
      const uniform = snapshotContributors(evidence.uniform);
      const overrides = Object.fromEntries(
        Object.entries(evidence.overrides ?? {}).map(([key, receipts]) => [
          key,
          snapshotContributors(receipts),
        ]),
      );
      const result = await provider.lookup(...args);
      return result ? captureKnowledgeResult(result, uniform, overrides) : null;
    },
  };
}
