import type * as maplibregl from "maplibre-gl";
import { alignmentCacheKey, computeStreetGridAlignment } from "./streetGrid";

type Listener = (available: boolean) => void;

/** One settled-view probe and one set of map listeners for all hook consumers. */
class StreetGridAvailability {
  private readonly listeners = new Set<Listener>();
  private available = false;
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
    listener(this.available);
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

  private publish(available: boolean): void {
    if (this.available === available) return;
    this.available = available;
    for (const listener of this.listeners) listener(available);
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
    this.publish(false);
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
    this.publish(false);
    // Source data can arrive tile by tile. The next idle coalesces the batch.
  };

  private readonly onSettled = (): void => this.queueIfNeeded();

  private queueIfNeeded(): void {
    if (this.listeners.size === 0 || this.timer !== null) return;
    const key = alignmentCacheKey(this.map, this.styleVersion);
    if (!this.roadsChanged && this.sampledKey === key) return;
    this.publish(false);
    if (this.map.isMoving() || !this.map.loaded()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.map.isMoving() || !this.map.loaded()) return;
      const currentKey = alignmentCacheKey(this.map, this.styleVersion);
      const result = computeStreetGridAlignment(this.map);
      this.sampledKey = currentKey;
      this.roadsChanged = false;
      this.publish(result.status === "ok" || result.status === "aligned");
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
