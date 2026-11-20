import { buildProducerIndex, selectProducer } from "./producer-index";
import type { LoadedService } from "./types";

/**
 * Resolve upstream service ids for cycle detection and ordering. Explicit
 * instances match exactly; an omitted instance selects the default producer,
 * then the sole producer entry for that type. Missing or ambiguous selections
 * add no edge: the Compose renderer owns their diagnostics and duplicate
 * producer validation. The supplied service subset is used without filtering.
 */
export function resolveConsumesDependencies(
  services: readonly LoadedService[],
): ReadonlyMap<string, readonly string[]> {
  const index = buildProducerIndex(services, { onDuplicate: "first" });
  const dependencies = new Map<string, string[]>();
  for (const service of services) {
    const upstream: string[] = [];
    for (const consumes of service.manifest.consumes ?? []) {
      const selection = selectProducer(consumes, index);
      // Self-produced data is mediated by the host's hardlink apply; it is
      // still mounted by the renderer but must not create a graph cycle.
      if (selection.kind === "found" && selection.entry.producerId !== service.manifest.id) {
        upstream.push(selection.entry.producerId);
      }
    }
    dependencies.set(service.manifest.id, upstream);
  }
  return dependencies;
}
