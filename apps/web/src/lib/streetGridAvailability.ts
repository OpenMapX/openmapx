import type * as maplibregl from "maplibre-gl";
import {
  alignmentCacheKey,
  computeStreetGridAlignment,
  type StreetGridAlignment,
} from "./streetGrid";

/**
 * The street grid's axis as a compass bearing folded into [0, 90), or null
 * while there is no grid to align to.
 */
export type StreetGridAxis = number | null;

type Listener = (axis: StreetGridAxis) => void;

/** The grid axis a settled result implies: its target bearing, or the current one when already aligned. */
function gridAxis(result: StreetGridAlignment, currentBearing: number): StreetGridAxis {
  if (result.status !== "ok" && result.status !== "aligned") return null;
  const bearing = result.status === "ok" ? result.bearing : currentBearing;
  return Math.round((((bearing % 90) + 90) % 90) * 2) / 2;
}

/** One settled-view probe and one set of map listeners for all hook consumers. */
class StreetGridAvailability {
  private readonly listeners = new Set<Listener>();
  private axis: StreetGridAxis = null;
  private sampledKey: string | null = null;
  private roadsChanged = true;
  private roadSourceIds = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly map: maplibregl.Map,
    private styleVersion: number,
  ) {
    this.refreshRoadSources();
    map.on("movestart", this.onMoveStart);
    map.on("moveend", this.onSettled);
    map.on("idle", this.onSettled);
    map.on("sourcedata", this.onSourceData);
    map.on("style.load", this.onStyleLoad);
  }

  subscribe(styleVersion: number, listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.styleVersion !== styleVersion) this.invalidateStyle(styleVersion);
    listener(this.axis);
    this.queueIfNeeded();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.cancelTimer();
      this.map.off("movestart", this.onMoveStart);
      this.map.off("moveend", this.onSettled);
      this.map.off("idle", this.onSettled);
      this.map.off("sourcedata", this.onSourceData);
      this.map.off("style.load", this.onStyleLoad);
      detectors.delete(this.map);
    };
  }

  private publish(axis: StreetGridAxis): void {
    // The axis is rounded, so an unchanged grid is equal and doesn't re-render consumers.
    if (this.axis === axis) return;
    this.axis = axis;
    for (const listener of this.listeners) listener(axis);
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private invalidateStyle(version: number): void {
    this.styleVersion = version;
    this.sampledKey = null;
    this.roadsChanged = true;
    this.refreshRoadSources();
    this.cancelTimer();
    this.publish(null);
  }

  private refreshRoadSources(): void {
    try {
      this.roadSourceIds = new Set(
        (this.map.getStyle()?.layers ?? []).flatMap((layer) =>
          layer.type === "line" && layer["source-layer"] === "transportation" ? [layer.source] : [],
        ),
      );
    } catch {
      this.roadSourceIds.clear();
    }
  }

  private readonly onMoveStart = (): void => {
    this.cancelTimer();
  };

  private readonly onStyleLoad = (): void => {
    this.invalidateStyle(this.styleVersion);
    this.queueIfNeeded();
  };

  private readonly onSourceData = (event: maplibregl.MapSourceDataEvent): void => {
    if (event.dataType !== "source" || !event.sourceId || !this.roadSourceIds.has(event.sourceId))
      return;
    this.roadsChanged = true;
    this.publish(null);
    // Source data can arrive tile by tile. The next idle coalesces the batch.
  };

  private readonly onSettled = (): void => this.queueIfNeeded();

  private queueIfNeeded(): void {
    if (this.listeners.size === 0 || this.timer !== null) return;
    const key = alignmentCacheKey(this.map, this.styleVersion);
    if (!this.roadsChanged && this.sampledKey === key) return;
    this.publish(null);
    if (this.map.isMoving() || !this.map.loaded()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.map.isMoving() || !this.map.loaded()) return;
      const currentKey = alignmentCacheKey(this.map, this.styleVersion);
      const result = computeStreetGridAlignment(this.map);
      this.sampledKey = currentKey;
      this.roadsChanged = false;
      this.publish(gridAxis(result, this.map.getBearing()));
    }, 0);
  }
}

const detectors = new WeakMap<maplibregl.Map, StreetGridAvailability>();

export function subscribeStreetGridAvailability(
  map: maplibregl.Map,
  styleVersion: number,
  listener: Listener,
): () => void {
  let detector = detectors.get(map);
  if (!detector) {
    detector = new StreetGridAvailability(map, styleVersion);
    detectors.set(map, detector);
  }
  return detector.subscribe(styleVersion, listener);
}
