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
  const defaultProducers = new Map<string, string>();
  const instancedProducers = new Map<string, string>();
  const producersByType = new Map<string, string[]>();
  for (const service of services) {
    for (const produces of service.manifest.produces ?? []) {
      if (produces.instance === undefined) {
        defaultProducers.set(produces.type, service.manifest.id);
      } else {
        instancedProducers.set(`${produces.type}/${produces.instance}`, service.manifest.id);
      }
      const list = producersByType.get(produces.type) ?? [];
      list.push(service.manifest.id);
      producersByType.set(produces.type, list);
    }
  }

  const dependencies = new Map<string, string[]>();
  for (const service of services) {
    const upstream: string[] = [];
    for (const consumes of service.manifest.consumes ?? []) {
      const candidates = producersByType.get(consumes.type);
      const producer =
        consumes.instance !== undefined
          ? instancedProducers.get(`${consumes.type}/${consumes.instance}`)
          : (defaultProducers.get(consumes.type) ??
            (candidates?.length === 1 ? candidates[0] : undefined));
      // Self-produced data is mediated by the host's hardlink apply; it is
      // still mounted by the renderer but must not create a graph cycle.
      if (producer && producer !== service.manifest.id) upstream.push(producer);
    }
    dependencies.set(service.manifest.id, upstream);
  }
  return dependencies;
}
