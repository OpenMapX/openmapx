import {
  type AttributionPresentation,
  buildAttributionPresentation,
} from "@openmapx/core/attribution";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { parseContributors } from "@openmapx/mobility-core/contributors";
import type { MapGeoJSONFeature, Map as MapLibreMap } from "maplibre-gl";
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
  /**
   * Trusted resolver optimization: equal keys within one layer must resolve to
   * identical receipts, including absence. Include every input to the resolver.
   * Scoped to one refresh so source/style updates and new closures cannot reuse
   * stale results. Omit to resolve independently for every visible feature.
   */
  featureContributorKey?: (feature: MapGeoJSONFeature) => string | undefined;
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

type Subscription = GeometrySubscription | RasterSubscription;

const trackers = new WeakMap<MapLibreMap, RenderedMapAttributionTracker>();
const REFRESH_INTERVAL_MS = 250;

/** Bounded per-map memoization. Keys contain whole portable snapshots, never source IDs. */
class ContentCache<T> {
  private entries = new Map<string, T>();
  private characters = 0;
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }
  set(key: string, value: T): void {
    // Do not retain arbitrarily large notices or an unbounded history of tiles.
    if (key.length > 65_536) return;
    if (this.entries.delete(key)) this.characters -= key.length;
    this.entries.set(key, value);
    this.characters += key.length;
    while (this.entries.size > 512 || this.characters > 1_048_576) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.characters -= oldest.length;
    }
  }
}

/** One event-driven scheduler and viewport query shared by every map owner. */
class RenderedMapAttributionTracker {
  private subscriptions = new Map<string, Subscription>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastQueryAt = Number.NEGATIVE_INFINITY;
  private groups = new ContentCache<readonly AttributionPresentation[]>();
  private presentations = new ContentCache<AttributionPresentation>();

  private onIdle = () => this.schedule();
  private onRender = () => this.schedule();
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
    // Query once and route hits once, rather than scanning every other owner's
    // features. Keep render/idle queries: late placement and paint transitions
    // can change visible content without camera/source events (or global idle).
    const featuresByLayer = new Map<string, MapGeoJSONFeature[]>();
    for (const feature of features) {
      const group = featuresByLayer.get(feature.layer.id);
      if (group) group.push(feature);
      else featuresByLayer.set(feature.layer.id, [feature]);
    }
    const paintEvidence = createRenderedPaintEvidence(this.map);
    const groupsThisRefresh = new Map<string, readonly AttributionPresentation[]>();
    const presentationsThisRefresh = new Map<string, AttributionPresentation>();
    const projectGroup = (key: string, raw: unknown): readonly AttributionPresentation[] => {
      const cached = groupsThisRefresh.get(key) ?? this.groups.get(key);
      if (cached !== undefined) {
        groupsThisRefresh.set(key, cached);
        return cached;
      }
      const projected = new Map<string, AttributionPresentation>();
      for (const receipt of parseContributors(raw) ?? []) {
        // Include retrievedAt, publisher, all bindings/policies and exact wording.
        // contributorKey intentionally ignores retrieval time and is insufficient here.
        const receiptKey = JSON.stringify(receipt);
        let entry = presentationsThisRefresh.get(receiptKey) ?? this.presentations.get(receiptKey);
        if (entry === undefined) {
          entry = buildAttributionPresentation(receipt, "map");
          this.presentations.set(receiptKey, entry);
        }
        presentationsThisRefresh.set(receiptKey, entry);
        if (entry.fullHtml) projected.set(receiptKey, entry);
      }
      const result = [...projected.values()];
      groupsThisRefresh.set(key, result);
      this.groups.set(key, result);
      return result;
    };
    for (const [owner, subscription] of this.subscriptions) {
      const entries = new Map<string, AttributionPresentation>();
      const seenGroups = new Set<string>();
      const addReceipts = (raw: unknown) => {
        const key = typeof raw === "string" ? raw : JSON.stringify(raw);
        if (key === undefined || seenGroups.has(key)) return;
        seenGroups.add(key);
        for (const entry of projectGroup(key, raw)) entries.set(JSON.stringify(entry), entry);
      };
      if (subscription.kind === "raster") {
        for (const descriptor of subscription.descriptors) {
          updateRasterAcquisitionContributors(
            this.map,
            descriptor.sourceId,
            descriptor.contributors,
          );
          addReceipts(rasterMapContributors(this.map, descriptor.layerId, descriptor.sourceId));
        }
        subscription.publish(
          [...entries.values()].sort((a, b) => a.fullHtml.localeCompare(b.fullHtml)),
        );
        continue;
      }
      addReceipts(subscription.resolveCustomContributors?.() ?? []);
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
      for (const layerId of live) {
        const resolved = new Map<string, readonly Attribution[] | undefined>();
        const seenProjections = new Set<string>();
        for (const feature of featuresByLayer.get(layerId) ?? []) {
          if (
            !hasVisibleFeatureChannel(
              feature,
              this.map,
              paintEvidence,
              partialGradientLayers.has(layerId),
            )
          )
            continue;
          const key = subscription.resolveFeatureContributors
            ? subscription.featureContributorKey?.(feature)
            : undefined;
          if (key !== undefined && seenProjections.has(key)) continue;
          let receipts: readonly Attribution[] | undefined;
          if (key !== undefined && resolved.has(key)) receipts = resolved.get(key);
          else {
            receipts = subscription.resolveFeatureContributors?.(feature);
            if (key !== undefined) resolved.set(key, receipts);
          }
          if (receipts !== undefined) {
            if (key !== undefined) seenProjections.add(key);
            addReceipts(receipts);
          } else {
            // Present empty/invalid metadata blocks the uniform fallback.
            const captured = feature.properties?._mapAttributions;
            addReceipts(
              captured === undefined ? (subscription.layerContributors?.[layerId] ?? []) : captured,
            );
          }
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
