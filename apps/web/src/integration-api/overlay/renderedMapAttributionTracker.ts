import Point from "@mapbox/point-geometry";
import {
  type AttributionPresentation,
  buildAttributionPresentation,
} from "@openmapx/core/attribution";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  readCapturedContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { MapGeoJSONFeature, Map as MapLibreMap } from "maplibre-gl";
import { installedNativeBasemap } from "./nativeBasemap";
import { evaluatedNativePaint, nativeRasterCoverage, type Ring } from "./nativeRasterCoverage";
import {
  nativeBackgroundExposed,
  queryNativeScreenDomains,
  queryNativeTileDomains,
} from "./nativeTileQuery";
import {
  rasterMapContributors,
  updateRasterAcquisitionContributors,
} from "./rasterMapContribution";
import { hasVisibleFeatureChannel, isAttributionLayerVisible } from "./renderedFeatureVisibility";
import { createRenderedPaintEvidence } from "./renderedPaintEvidence";

export interface RenderedMapAttributionOptions {
  /**
   * Trusted host certification: each group paints identical geometry with the
   * same captured receipts, and its alpha union covers that entire geometry.
   * Every member must be subscribed and live. Generic partial gradients must
   * instead split geometry. Never derive this certification from remote data.
   */
  complementaryGradientGroups?: readonly (readonly string[])[];
  layerContributors?: Readonly<Record<string, readonly Attribution[]>>;
  /** Trusted host proof for painted DOM/custom-GPU content outside feature queries. Never supplied by remote data. */
  resolveCustomContributors?: () => readonly Attribution[];
  resolveFeatureContributors?: (feature: MapGeoJSONFeature) => readonly Attribution[] | undefined;
}

interface GeometrySubscription extends RenderedMapAttributionOptions {
  kind: "geometry";
  layerIds: readonly string[];
  publish: (entries: AttributionPresentation[]) => void;
}

export interface RasterAttributionDescriptor {
  layerId: string;
  sourceId: string;
  contributors: readonly Attribution[];
}

interface RasterSubscription {
  kind: "raster";
  descriptors: readonly RasterAttributionDescriptor[];
  publish: (entries: AttributionPresentation[]) => void;
}

interface NativeSubscription {
  kind: "native";
  publish: (entries: AttributionPresentation[]) => void;
}
type Subscription = GeometrySubscription | RasterSubscription | NativeSubscription;

const trackers = new WeakMap<MapLibreMap, RenderedMapAttributionTracker>();
const REFRESH_INTERVAL_MS = 250;

/** One event-driven scheduler and viewport query shared by every map owner. */
class RenderedMapAttributionTracker {
  private subscriptions = new Map<string, Subscription>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastQueryAt = Number.NEGATIVE_INFINITY;

  private awaitingRender = false;
  private suppressRepaintIdle = false;
  private onIdle = () => {
    if (this.suppressRepaintIdle) {
      this.suppressRepaintIdle = false;
      return;
    }
    this.schedule();
  };
  private onRender = () => {
    if (this.awaitingRender) {
      this.awaitingRender = false;
      this.suppressRepaintIdle = true;
      this.refresh();
    } else this.schedule();
  };
  constructor(private map: MapLibreMap) {}

  subscribe(owner: string, subscription: Subscription): () => void {
    if (this.subscriptions.size === 0) {
      this.map.on("render", this.onRender);
      this.map.on("idle", this.onIdle);
    }
    this.captureRaster(subscription);
    this.subscriptions.set(owner, subscription);
    this.schedule();
    return () => {
      this.subscriptions.delete(owner);
      subscription.publish([]);
      if (this.subscriptions.size === 0) {
        this.map.off("render", this.onRender);
        this.map.off("idle", this.onIdle);
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        trackers.delete(this.map);
      }
    };
  }

  update(owner: string, subscription: Subscription): void {
    if (!this.subscriptions.has(owner)) return;
    this.captureRaster(subscription);
    this.subscriptions.set(owner, subscription);
    this.schedule();
  }

  private captureRaster(subscription: Subscription): void {
    if (subscription.kind !== "raster") return;
    for (const descriptor of subscription.descriptors) {
      updateRasterAcquisitionContributors(this.map, descriptor.sourceId, descriptor.contributors);
    }
  }

  private schedule = () => {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(
      () => {
        if ([...this.subscriptions.values()].some((s) => s.kind === "native")) {
          this.timer = undefined;
          this.awaitingRender = true;
          this.map.triggerRepaint();
        } else this.refresh();
      },
      Math.max(0, REFRESH_INTERVAL_MS - (performance.now() - this.lastQueryAt)),
    );
  };

  private refresh = () => {
    this.timer = undefined;
    this.lastQueryAt = performance.now();
    const layersByOwner = new Map<string, Set<string>>();
    const layers = new Set<string>();
    for (const [owner, subscription] of this.subscriptions) {
      if (subscription.kind !== "geometry") continue;
      const live = new Set(
        subscription.layerIds.filter((id) => isAttributionLayerVisible(this.map, id)),
      );
      layersByOwner.set(owner, live);
      for (const id of live) layers.add(id);
    }
    // A global isStyleLoaded gate would suppress retained content whenever an
    // unrelated source is pending. An empty live layer union is the teardown gate.
    const native = [...this.subscriptions.values()].some((s) => s.kind === "native")
      ? installedNativeBasemap(this.map)
          .layers()
          .filter((l) => isAttributionLayerVisible(this.map, l.id))
      : [];
    const coverage = nativeRasterCoverage(
      this.map,
      native.map((l) => l.id),
    );
    const features = layers.size
      ? this.map.queryRenderedFeatures(undefined, { layers: [...layers] })
      : [];
    const paintEvidence = createRenderedPaintEvidence(this.map);
    for (const [owner, subscription] of this.subscriptions) {
      const entries = new Map<string, AttributionPresentation>();
      if (subscription.kind === "native") {
        const proven = new Set<string>();
        const add = (receipts: readonly Attribution[]) => {
          for (const receipt of receipts) {
            proven.add(JSON.stringify(receipt));
            const entry = buildAttributionPresentation(receipt, "map");
            if (entry.fullHtml) entries.set(JSON.stringify(entry), entry);
          }
        };
        // Group identical exposed regions, then stop only once every candidate
        // receipt has positive native query + evaluated paint evidence.
        const groups = new Map<
          unknown,
          {
            ids: string[];
            regions: Ring[] | undefined;
            globeMask?: import("./nativeRasterCoverage").MultiPolygon;
          }
        >();
        const backgrounds: typeof native = [];
        const bindings = new Map(native.map((b) => [b.id, b]));
        for (const binding of native) {
          const regions = coverage.regions.get(binding.id);
          const globeMask = coverage.globeMasks?.get(binding.id);
          const layer = this.map.style.getLayer(binding.id);
          if (layer?.type === "background") {
            backgrounds.push(binding);
            continue;
          }
          const key = globeMask?.length ? globeMask : regions;
          const group = groups.get(key) ?? { ids: [], regions, globeMask };
          group.ids.push(binding.id);
          groups.set(key, group);
        }
        for (const group of groups.values()) {
          const pending = () =>
            group.ids.filter(
              (id) => !bindings.get(id)?.contributors.every((r) => proven.has(JSON.stringify(r))),
            );
          const inspect = (hits: MapGeoJSONFeature[]) => {
            for (const feature of hits) {
              const binding = bindings.get(feature.layer.id);
              if (
                binding &&
                group.ids.includes(binding.id) &&
                hasVisibleFeatureChannel(feature, this.map, paintEvidence)
              )
                add(binding.contributors);
            }
          };
          const geometry = pending().filter((id) => this.map.getLayer(id)?.type !== "symbol");
          if (geometry.length) {
            const complete = () =>
              geometry.every((id) =>
                bindings.get(id)?.contributors.every((r) => proven.has(JSON.stringify(r))),
              );
            const supported = group.globeMask?.length
              ? queryNativeTileDomains(
                  this.map,
                  geometry,
                  group.globeMask,
                  (hit) => inspect([hit]),
                  complete,
                )
              : queryNativeScreenDomains(
                  this.map,
                  geometry,
                  group.regions,
                  (hit) => inspect([hit]),
                  complete,
                );
            if (!supported) {
              // Unsupported actual terrain/type retains native engine evidence;
              // it never certifies raster occlusion from an approximate domain.
              inspect(this.map.queryRenderedFeatures(undefined, { layers: geometry }));
            }
          }
          const symbols = pending().filter((id) => this.map.getLayer(id)?.type === "symbol");
          if (!symbols.length) continue;
          if (!group.regions)
            inspect(this.map.queryRenderedFeatures(undefined, { layers: symbols }));
          else
            for (const ring of group.regions) {
              const remaining = pending().filter((id) => symbols.includes(id));
              if (!remaining.length) break;
              inspect(
                this.map.style.queryRenderedFeatures(
                  ring.map((p) => new Point(p[0], p[1])),
                  { layers: remaining },
                  this.map.painter.frameRenderContext.transform,
                ),
              );
            }
        }
        for (const binding of backgrounds) {
          if (binding.contributors.every((r) => proven.has(JSON.stringify(r)))) continue;
          const layer = this.map.style.getLayer(binding.id);
          if (!layer) continue;
          const regions = coverage.regions.get(binding.id);
          const globeMask = coverage.globeMasks?.get(binding.id);
          const paint = evaluatedNativePaint(layer.paint);
          const color = paint?.get("background-color");
          const opacity = paint?.get("background-opacity");
          if (
            (globeMask
              ? nativeBackgroundExposed(this.map, globeMask) !== false
              : regions === undefined || regions.length > 0) &&
            typeof opacity === "number" &&
            opacity > 0 &&
            color &&
            typeof color === "object" &&
            "a" in color &&
            typeof color.a === "number" &&
            color.a > 0
          )
            add(binding.contributors);
        }
        subscription.publish(
          [...entries.values()].sort((a, b) => a.fullHtml.localeCompare(b.fullHtml)),
        );
        continue;
      }
      if (subscription.kind === "raster") {
        for (const descriptor of subscription.descriptors) {
          updateRasterAcquisitionContributors(
            this.map,
            descriptor.sourceId,
            descriptor.contributors,
          );
          for (const receipt of rasterMapContributors(
            this.map,
            descriptor.layerId,
            descriptor.sourceId,
          )) {
            const entry = buildAttributionPresentation(receipt, "map");
            if (entry.fullHtml) entries.set(JSON.stringify(entry), entry);
          }
        }
        subscription.publish(
          [...entries.values()].sort((a, b) => a.fullHtml.localeCompare(b.fullHtml)),
        );
        continue;
      }
      for (const receipt of snapshotContributors(
        subscription.resolveCustomContributors?.() ?? [],
      )) {
        const entry = buildAttributionPresentation(receipt, "map");
        if (entry.fullHtml) entries.set(JSON.stringify(entry), entry);
      }
      const live = layersByOwner.get(owner);
      if (!live) continue;
      const partialGradientLayers = new Set<string>();
      for (const declared of subscription.complementaryGradientGroups ?? []) {
        const group = [...new Set(declared)];
        if (
          group.length < 2 ||
          !group.every((id) => live.has(id) && this.map.getLayer(id)?.type === "line")
        )
          continue;
        for (const id of group) partialGradientLayers.add(id);
      }
      for (const feature of features) {
        if (
          !live.has(feature.layer.id) ||
          !hasVisibleFeatureChannel(
            feature,
            this.map,
            paintEvidence,
            partialGradientLayers.has(feature.layer.id),
          )
        )
          continue;
        const receipts =
          subscription.resolveFeatureContributors?.(feature) ??
          readCapturedContributors(feature.properties?._mapAttributions) ??
          subscription.layerContributors?.[feature.layer.id] ??
          [];
        for (const receipt of snapshotContributors(receipts)) {
          const entry = buildAttributionPresentation(receipt, "map");
          if (entry.fullHtml) entries.set(JSON.stringify(entry), entry);
        }
      }
      subscription.publish(
        [...entries.values()].sort((a, b) => a.fullHtml.localeCompare(b.fullHtml)),
      );
    }
  };
}

export function renderedMapAttributionTracker(map: MapLibreMap): RenderedMapAttributionTracker {
  let tracker = trackers.get(map);
  if (!tracker) {
    tracker = new RenderedMapAttributionTracker(map);
    trackers.set(map, tracker);
  }
  return tracker;
}
