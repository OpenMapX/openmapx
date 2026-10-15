import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

export interface NativeBasemapCandidate {
  style: StyleSpecification;
  offline: boolean;
  sourceContributors: Readonly<Record<string, readonly Attribution[]>>;
  styleContributors: readonly Attribution[];
}
export interface NativeBasemapLayer {
  id: string;
  contributors: readonly Attribution[];
}
function generation(style: StyleSpecification | undefined): unknown {
  const metadata = style?.metadata;
  return metadata && typeof metadata === "object" && GENERATION in metadata
    ? metadata[GENERATION]
    : undefined;
}
const GENERATION = "openmapx:native-basemap-generation";
const installed = new WeakMap<MapLibreMap, InstalledNativeBasemap>();

/** Host-owned installed source generations. A style diff may retain both Style
 * and Source objects, so neither a source ID nor today's configuration is lineage. */
export class InstalledNativeBasemap {
  private sources = new WeakMap<object, Attribution[]>();
  private bindings: Array<
    NativeBasemapLayer & { layer: object; source?: object; sourceId?: string }
  > = [];
  private style?: object;

  private subscribers = new Set<(contributors: Attribution[]) => void>();
  private contributors(): Attribution[] {
    // A full-style rebuild replaces engine objects before style.load, while
    // the last painted frame can still need the previous installed receipts.
    const layers = this.pending ? this.bindings : this.layers();
    return snapshotContributors(...layers.map((layer) => layer.contributors));
  }
  private notify = () => {
    const contributors = this.contributors();
    for (const publish of this.subscribers) publish(contributors);
  };
  private remove = () => {
    this.map.off("style.load", this.promote);
    this.map.off("styledata", this.notify);
    this.map.off("remove", this.remove);
    this.subscribers.clear();
  };

  /** Publish installed-style events independently of rendered geometry. */
  subscribe(publish: (contributors: Attribution[]) => void): () => void {
    this.subscribers.add(publish);
    publish(this.contributors());
    return () => {
      this.subscribers.delete(publish);
    };
  }

  private pending?: NativeBasemapCandidate;
  private installedCallback?: (offline: boolean) => void;
  constructor(private map: MapLibreMap) {
    map.on?.("style.load", this.promote);
    map.on?.("styledata", this.notify);
    map.on?.("remove", this.remove);
  }
  private promote = () => {
    const candidate = this.pending;
    if (!candidate || generation(this.map.getStyle()) !== generation(candidate.style)) return;
    this.adopt(candidate);
    this.pending = undefined;
    this.installedCallback?.(candidate.offline);
  };
  /** Set pending before setStyle: object diffs can emit style.load synchronously.
   * A no-op diff has no event and keeps its old receipts. */
  install(
    candidate: NativeBasemapCandidate,
    onInstalled: (offline: boolean) => void,
    initial = false,
  ): void {
    this.pending = structuredClone(candidate);
    this.installedCallback = onInstalled;
    if (!initial) this.map.setStyle(candidate.style);
  }

  adopt(candidate: NativeBasemapCandidate): void {
    this.style = this.map.style;
    this.bindings = candidate.style.layers.flatMap((spec) => {
      const layer = this.map.getLayer(spec.id);
      if (!layer) return [];
      const sourceId =
        "source" in spec && typeof spec.source === "string" ? spec.source : undefined;
      const source = sourceId ? this.map.getSource(sourceId) : undefined;
      if (sourceId && !source) return [];
      if (source && sourceId && !this.sources.has(source)) {
        this.sources.set(
          source,
          snapshotContributors(candidate.sourceContributors[sourceId] ?? []),
        );
      }
      return [
        {
          id: spec.id,
          layer,
          source,
          sourceId,
          contributors: snapshotContributors(
            source ? (this.sources.get(source) ?? []) : [],
            candidate.styleContributors,
          ),
        },
      ];
    });
    this.notify();
  }

  layers(): NativeBasemapLayer[] {
    if (this.map.style !== this.style) return [];
    return this.bindings.filter(
      (b) =>
        this.map.getLayer(b.id) === b.layer &&
        (!b.sourceId || this.map.getSource(b.sourceId) === b.source),
    );
  }
}
export function installedNativeBasemap(map: MapLibreMap): InstalledNativeBasemap {
  let controller = installed.get(map);
  if (!controller) {
    controller = new InstalledNativeBasemap(map);
    installed.set(map, controller);
  }
  return controller;
}
