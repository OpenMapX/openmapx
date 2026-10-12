import type { RoadConditionEvent } from "@openmapx/core";
import { dataSourceToAttribution, type IntegrationRegistry } from "@openmapx/integration-framework";

export type RoadConditionCredit = ReturnType<typeof dataSourceToAttribution>;

/** Credit only these incidents, resolving catalogue children through their parent. */
export function roadConditionAttributions(
  events: readonly RoadConditionEvent[],
  registry?: IntegrationRegistry,
): RoadConditionCredit[] {
  const credits = new Map<string, RoadConditionCredit>();
  const add = (credit: RoadConditionCredit) => credits.set(JSON.stringify(credit), credit);
  for (const event of events) {
    const sourceId = event.attribution.sourceId ?? event.source;
    const source = registry?.findDataSource(sourceId);
    if (source) add(dataSourceToAttribution(source));
    else {
      // Federated, crowd and third-party records need not have a catalogue row.
      // Their own provenance is the fallback, never the provider's entire list.
      const { provider, license, url } = event.attribution;
      if (provider || sourceId) {
        add({
          sourceId: sourceId || event.provider,
          name: provider || sourceId,
          ...(license ? { spdxLicense: license } : {}),
          ...(url ? (license ? { licenseUrl: url } : { url }) : {}),
        });
      }
    }
    if (event.attribution.notice) add({ sourceId, name: event.attribution.notice });
  }
  return [...credits.values()];
}
