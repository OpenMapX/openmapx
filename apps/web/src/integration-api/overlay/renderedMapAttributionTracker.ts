import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  readCapturedContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { MapGeoJSONFeature, Map as MapLibreMap } from "maplibre-gl";
import {
  rasterMapContributors,
  updateRasterAcquisitionContributors,
} from "./rasterMapContribution";
import { hasVisibleFeatureChannel, isAttributionLayerVisible } from "./renderedFeatureVisibility";
import { createRenderedPaintEvidence } from "./renderedPaintEvidence";
import { attributionToHtml } from "./useMapAttributions";

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
  publish: (html: string[]) => void;
}

export interface RasterAttributionDescriptor {
  layerId: string;
  sourceId: string;
  contributors: readonly Attribution[];
}

interface RasterSubscription {
  kind: "raster";
  descriptors: readonly RasterAttributionDescriptor[];
  publish: (html: string[]) => void;
}

type Subscription = GeometrySubscription | RasterSubscription;

const trackers = new WeakMap<MapLibreMap, RenderedMapAttributionTracker>();
const REFRESH_INTERVAL_MS = 250;

/** One event-driven scheduler and viewport query shared by every map owner. */
class RenderedMapAttributionTracker {
  private subscriptions = new Map<string, Subscription>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastQueryAt = Number.NEGATIVE_INFINITY;

  constructor(private map: MapLibreMap) {}

  subscribe(owner: string, subscription: Subscription): () => void {
    if (this.subscriptions.size === 0) {
      this.map.on("render", this.schedule);
      this.map.on("idle", this.schedule);
    }
    this.captureRaster(subscription);
    this.subscriptions.set(owner, subscription);
    this.schedule();
    return () => {
      this.subscriptions.delete(owner);
      subscription.publish([]);
      if (this.subscriptions.size === 0) {
        this.map.off("render", this.schedule);
        this.map.off("idle", this.schedule);
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
      this.refresh,
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
    const features = layers.size
      ? this.map.queryRenderedFeatures(undefined, { layers: [...layers] })
      : [];
    const paintEvidence = createRenderedPaintEvidence(this.map);
    for (const [owner, subscription] of this.subscriptions) {
      const html = new Set<string>();
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
            const entry = attributionToHtml(receipt);
            if (entry) html.add(entry);
          }
        }
        subscription.publish([...html].sort());
        continue;
      }
      for (const receipt of snapshotContributors(
        subscription.resolveCustomContributors?.() ?? [],
      )) {
        const entry = attributionToHtml(receipt);
        if (entry) html.add(entry);
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
          const entry = attributionToHtml(receipt);
          if (entry) html.add(entry);
        }
      }
      subscription.publish([...html].sort());
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
