import type { LoadedService, ServiceConsumes, ServiceProduces } from "./types";

export interface ProducerEntry {
  producerId: string;
  produces: ServiceProduces;
}

/**
 * Producers keyed by `<type>` for default producers and `<type>/<instance>`
 * for instanced ones, so consumer lookups are O(1).
 */
export interface ProducerIndex {
  /** type → entry, only set when the producer has no `instance` (the "default"). */
  default: Map<string, ProducerEntry>;
  /** `${type}/${instance}` → entry. */
  instanced: Map<string, ProducerEntry>;
  /** type → all entries (default + instanced) for fall-back lookup. */
  byType: Map<string, ProducerEntry[]>;
}

export type ProducerSelection =
  | { kind: "found"; entry: ProducerEntry }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: readonly ProducerEntry[] };

/**
 * Index the producers of `services`. A second default producer of a type, or
 * a second producer of one (type, instance), either throws (the Compose
 * renderer, which must refuse such a registry) or loses to the first one
 * (planning code, which leaves the diagnostic to the renderer).
 */
export function buildProducerIndex(
  services: readonly LoadedService[],
  options: { onDuplicate: "throw" | "first" },
): ProducerIndex {
  const index: ProducerIndex = { default: new Map(), instanced: new Map(), byType: new Map() };
  for (const service of services) {
    for (const produces of service.manifest.produces ?? []) {
      const entry: ProducerEntry = { producerId: service.manifest.id, produces };
      if (produces.instance === undefined) {
        const existing = index.default.get(produces.type);
        if (existing && options.onDuplicate === "throw") {
          throw new Error(
            `Multiple default-instance producers for type "${produces.type}": ${existing.producerId} and ${service.manifest.id}. Disambiguate with distinct \`instance\` ids on the producers, then specify \`instance\` on consumers.`,
          );
        }
        if (!existing) index.default.set(produces.type, entry);
      } else {
        const key = `${produces.type}/${produces.instance}`;
        const existing = index.instanced.get(key);
        if (existing && options.onDuplicate === "throw") {
          throw new Error(
            `Multiple producers for (type "${produces.type}", instance "${produces.instance}"): ${existing.producerId} and ${service.manifest.id}. Each (type, instance) pair must be unique across the registry.`,
          );
        }
        if (!existing) index.instanced.set(key, entry);
      }
      const list = index.byType.get(produces.type) ?? [];
      list.push(entry);
      index.byType.set(produces.type, list);
    }
  }
  return index;
}

/**
 * The producer a consumer entry selects. An explicit instance matches exactly;
 * an omitted instance selects the default producer, then the sole producer of
 * that type. Several producers and no default is ambiguous.
 */
export function selectProducer(consumes: ServiceConsumes, index: ProducerIndex): ProducerSelection {
  if (consumes.instance !== undefined) {
    const entry = index.instanced.get(`${consumes.type}/${consumes.instance}`);
    return entry ? { kind: "found", entry } : { kind: "missing" };
  }
  const entry = index.default.get(consumes.type);
  if (entry) return { kind: "found", entry };
  const candidates = index.byType.get(consumes.type) ?? [];
  if (candidates.length === 1 && candidates[0]) return { kind: "found", entry: candidates[0] };
  return candidates.length === 0 ? { kind: "missing" } : { kind: "ambiguous", candidates };
}
