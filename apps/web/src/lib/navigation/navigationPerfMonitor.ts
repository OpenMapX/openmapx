"use client";

import type { Map as MaplibreMap } from "maplibre-gl";

/**
 * Opt-in QA instrument for navigation performance and thermal characterization.
 *
 * Sustained navigation is a battery/heat problem, not a correctness problem:
 * unit tests cannot see a phone throttling after 20 minutes. This controller
 * collects the few counters that make a before/after comparison possible on a
 * real device — frame pacing, browser long tasks, MapLibre event churn,
 * navigation-store publications, and coarse network volume — so an optimization
 * can be judged against a captured baseline instead of a plausible story.
 *
 * It is a measurement aid, never telemetry:
 * - nothing runs until {@link NavigationPerfMonitor.start} is called (the UI
 *   gates that behind the `?navperf=1` flag plus an explicit click);
 * - only bounded aggregates are retained — a resource URL is classified on
 *   arrival and immediately discarded, so no coordinates, route geometry, query
 *   strings or API keys can reach an export;
 * - the clock, frame scheduler and observer factory are injected so the maths
 *   can be pinned deterministically in tests.
 */

/** Frame deltas retained for the percentile window; everything else is an online aggregate. */
const MAX_RETAINED_SAMPLES = 1000;

/** A jank frame: two missed 60 Hz frames. */
const SLOW_FRAME_MS = 32;

/** A visibly stuttering frame. */
const VERY_SLOW_FRAME_MS = 50;

/** MapLibre events that reveal render/camera churn during guidance. */
const MAP_EVENTS = ["render", "move", "moveend", "idle"] as const;

type MapEventName = (typeof MAP_EVENTS)[number];

/** Coarse network buckets; fine-grained per-endpoint accounting would need URLs. */
export type NavPerfResourceCategory = "tile" | "road-conditions" | "routing" | "other";

const RESOURCE_CATEGORIES: NavPerfResourceCategory[] = [
  "tile",
  "road-conditions",
  "routing",
  "other",
];

/**
 * The subset of `PerformanceEntry` this monitor reads. Declared structurally so
 * a test can hand in plain objects and so no browser type is required at build
 * time for the resource-timing fields.
 */
export interface NavPerfPerformanceEntry {
  entryType: string;
  name: string;
  duration: number;
  transferSize?: number;
  encodedBodySize?: number;
}

/** The only thing the monitor needs from a `PerformanceObserver`. */
export interface NavPerfObserverHandle {
  disconnect(): void;
}

/**
 * Creates an observer for one entry type, or returns null when the browser does
 * not support it (Firefox and Safari have no `longtask`). Returning null rather
 * than throwing is what lets the monitor degrade to "unsupported" cleanly.
 */
export type NavPerfObserverFactory = (
  entryType: string,
  onEntries: (entries: NavPerfPerformanceEntry[]) => void,
) => NavPerfObserverHandle | null;

/**
 * The navigation store, reduced to the one capability the monitor uses. A single
 * subscription counts how often navigation state is published and how often the
 * progress object identity actually changes — the per-fix publication budget.
 */
export interface NavPerfNavigationStore {
  subscribe(listener: (state: { progress: unknown }) => void): () => void;
}

/** Run context typed in by the tester; never derived from the device automatically. */
export interface NavPerfMetadata {
  deviceModel: string;
  browserVersion: string;
  buildSha: string;
  /** Screen brightness the run was pinned to, in percent. */
  brightnessPercent: string;
  networkType: string;
  scenario: string;
}

export interface NavPerfFrameStats {
  /** Frame-to-frame deltas measured since the last reset. */
  samples: number;
  /** Sum of those deltas, ms. */
  totalMs: number;
  /** Frames per second implied by the measured deltas; 0 before the second frame. */
  estimatedFps: number;
  longestMs: number;
  /** 95th percentile over the retained window (not the whole run). */
  p95Ms: number;
  over32ms: number;
  over50ms: number;
  /** Deltas still held by the bounded window; never above {@link MAX_RETAINED_SAMPLES}. */
  retainedSamples: number;
}

export interface NavPerfLongTaskStats {
  /** False when the browser has no `longtask` entry type. */
  supported: boolean;
  count: number;
  totalMs: number;
  longestMs: number;
}

export type NavPerfMapStats = Record<MapEventName, number>;

export interface NavPerfNavigationStats {
  /** Every store publication seen, whatever changed. */
  storeNotifications: number;
  /** Publications that actually swapped the progress object. */
  progressPublications: number;
}

export interface NavPerfResourceStats {
  count: number;
  totalDurationMs: number;
  transferBytes: number;
  encodedBytes: number;
}

export interface NavPerfSnapshot {
  running: boolean;
  elapsedMs: number;
  frames: NavPerfFrameStats;
  longTasks: NavPerfLongTaskStats;
  map: NavPerfMapStats;
  navigation: NavPerfNavigationStats;
  resources: Record<NavPerfResourceCategory, NavPerfResourceStats>;
  metadata: NavPerfMetadata;
}

export interface NavigationPerfMonitor {
  /** Begins measuring. A null map/store is allowed so the HUD can start early. */
  start(map: MaplibreMap | null, store: NavPerfNavigationStore | null): void;
  /** Detaches everything; safe to call any number of times. */
  stop(): void;
  /** Zeroes every aggregate without detaching, for a fresh measurement window. */
  reset(): void;
  snapshot(): NavPerfSnapshot;
  setMetadata(patch: Partial<NavPerfMetadata>): void;
}

export interface NavPerfMonitorDeps {
  now?: () => number;
  requestFrame?: (callback: (timestampMs: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  createObserver?: NavPerfObserverFactory;
}

/**
 * The four canonical measurement runs. Shared with the simulator control so a
 * before/after pair is captured under the same conditions rather than under
 * whatever the tester happened to do that day.
 */
export const NAV_PERF_SCENARIOS = [
  { key: "city", label: "city · 10 min · 14 m/s" },
  { key: "highway", label: "highway · 10 min · 33 m/s" },
  { key: "city-reroute", label: "city + 1 reroute · 10 min" },
  { key: "stationary", label: "stationary follow · 5 min" },
] as const;

/**
 * Bucket a resource URL and throw the URL away. Deliberately coarse: the
 * question a baseline answers is "did navigation start fetching more tiles or
 * more condition windows", which needs volume per family, not per endpoint.
 */
export function classifyNavPerfResource(url: string): NavPerfResourceCategory {
  const value = url.toLowerCase();
  if (
    value.includes(".pbf") ||
    value.includes(".mvt") ||
    value.includes("/tiles/") ||
    value.includes("/tile/") ||
    /\/\d{1,2}\/\d+\/\d+(\.[a-z0-9]+)?(\?|$)/.test(value)
  ) {
    return "tile";
  }
  if (
    value.includes("road-condition") ||
    value.includes("conditions") ||
    value.includes("traffic") ||
    value.includes("incident")
  ) {
    return "road-conditions";
  }
  if (
    value.includes("/route") ||
    value.includes("/directions") ||
    value.includes("/navigate") ||
    value.includes("/matrix")
  ) {
    return "routing";
  }
  return "other";
}

function emptyMetadata(): NavPerfMetadata {
  return {
    deviceModel: "",
    browserVersion: "",
    buildSha: "",
    brightnessPercent: "",
    networkType: "",
    scenario: "",
  };
}

function emptyResourceStats(): Record<NavPerfResourceCategory, NavPerfResourceStats> {
  const out = {} as Record<NavPerfResourceCategory, NavPerfResourceStats>;
  for (const category of RESOURCE_CATEGORIES) {
    out[category] = { count: 0, totalDurationMs: 0, transferBytes: 0, encodedBytes: 0 };
  }
  return out;
}

/**
 * Fixed-capacity window of the most recent frame deltas. Bounded on purpose: a
 * 30-minute run at 60 Hz would otherwise retain >100k numbers on the very device
 * whose memory pressure is under investigation.
 */
class RingBuffer {
  private readonly values: number[] = [];
  private cursor = 0;

  constructor(private readonly capacity: number) {}

  push(value: number): void {
    if (this.values.length < this.capacity) {
      this.values.push(value);
      return;
    }
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.capacity;
  }

  get size(): number {
    return this.values.length;
  }

  clear(): void {
    this.values.length = 0;
    this.cursor = 0;
  }

  percentile(fraction: number): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
    return sorted[index];
  }
}

function defaultObserverFactory(
  entryType: string,
  onEntries: (entries: NavPerfPerformanceEntry[]) => void,
): NavPerfObserverHandle | null {
  if (typeof PerformanceObserver === "undefined") return null;
  const supported = PerformanceObserver.supportedEntryTypes;
  if (Array.isArray(supported) && !supported.includes(entryType)) return null;
  try {
    const observer = new PerformanceObserver((list) => {
      onEntries(list.getEntries() as unknown as NavPerfPerformanceEntry[]);
    });
    observer.observe({ type: entryType, buffered: false });
    return observer;
  } catch {
    // An entry type the browser rejects at observe() time is simply unavailable.
    return null;
  }
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function createNavigationPerfMonitor(deps: NavPerfMonitorDeps = {}): NavigationPerfMonitor {
  const now =
    deps.now ?? (() => (typeof performance === "undefined" ? Date.now() : performance.now()));
  const requestFrame =
    deps.requestFrame ??
    ((callback: (timestampMs: number) => void) =>
      typeof requestAnimationFrame === "undefined" ? 0 : requestAnimationFrame(callback));
  const cancelFrame =
    deps.cancelFrame ??
    ((handle: number) => {
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(handle);
    });
  const createObserver = deps.createObserver ?? defaultObserverFactory;

  let running = false;
  let startedAtMs = 0;
  let stoppedElapsedMs = 0;
  let frameHandle: number | null = null;
  let lastFrameMs: number | null = null;

  let map: MaplibreMap | null = null;
  const mapListeners = new Map<MapEventName, () => void>();
  let unsubscribeStore: (() => void) | null = null;
  const observers: NavPerfObserverHandle[] = [];
  let longTasksSupported = false;
  let lastProgress: unknown = null;

  const metadata = emptyMetadata();
  const recentFrames = new RingBuffer(MAX_RETAINED_SAMPLES);
  let frameSamples = 0;
  let frameTotalMs = 0;
  let frameLongestMs = 0;
  let framesOver32 = 0;
  let framesOver50 = 0;
  let longTaskCount = 0;
  let longTaskTotalMs = 0;
  let longTaskLongestMs = 0;
  const mapCounts: NavPerfMapStats = { render: 0, move: 0, moveend: 0, idle: 0 };
  let storeNotifications = 0;
  let progressPublications = 0;
  let resources = emptyResourceStats();

  const zeroAggregates = () => {
    recentFrames.clear();
    frameSamples = 0;
    frameTotalMs = 0;
    frameLongestMs = 0;
    framesOver32 = 0;
    framesOver50 = 0;
    longTaskCount = 0;
    longTaskTotalMs = 0;
    longTaskLongestMs = 0;
    for (const event of MAP_EVENTS) mapCounts[event] = 0;
    storeNotifications = 0;
    progressPublications = 0;
    resources = emptyResourceStats();
    lastFrameMs = null;
  };

  const onFrame = (timestampMs: number) => {
    if (!running) return;
    if (lastFrameMs !== null) {
      const delta = timestampMs - lastFrameMs;
      if (delta >= 0) {
        frameSamples += 1;
        frameTotalMs += delta;
        recentFrames.push(delta);
        if (delta > frameLongestMs) frameLongestMs = delta;
        if (delta >= SLOW_FRAME_MS) framesOver32 += 1;
        if (delta >= VERY_SLOW_FRAME_MS) framesOver50 += 1;
      }
    }
    lastFrameMs = timestampMs;
    frameHandle = requestFrame(onFrame);
  };

  const onResourceEntries = (entries: NavPerfPerformanceEntry[]) => {
    if (!running) return;
    for (const entry of entries) {
      // Classify and drop: the URL never leaves this line.
      const bucket = resources[classifyNavPerfResource(entry.name)];
      bucket.count += 1;
      bucket.totalDurationMs += entry.duration ?? 0;
      bucket.transferBytes += entry.transferSize ?? 0;
      bucket.encodedBytes += entry.encodedBodySize ?? 0;
    }
  };

  const onLongTaskEntries = (entries: NavPerfPerformanceEntry[]) => {
    if (!running) return;
    for (const entry of entries) {
      longTaskCount += 1;
      longTaskTotalMs += entry.duration ?? 0;
      if ((entry.duration ?? 0) > longTaskLongestMs) longTaskLongestMs = entry.duration ?? 0;
    }
  };

  return {
    start(nextMap, store) {
      if (running) return;
      running = true;
      startedAtMs = now();
      zeroAggregates();
      lastProgress = null;

      map = nextMap;
      if (map) {
        for (const event of MAP_EVENTS) {
          const listener = () => {
            if (running) mapCounts[event] += 1;
          };
          mapListeners.set(event, listener);
          map.on(event, listener);
        }
      }

      if (store) {
        unsubscribeStore = store.subscribe((state) => {
          if (!running) return;
          storeNotifications += 1;
          if (state.progress !== lastProgress) {
            progressPublications += 1;
            lastProgress = state.progress;
          }
        });
      }

      const longTaskObserver = createObserver("longtask", onLongTaskEntries);
      longTasksSupported = longTaskObserver !== null;
      if (longTaskObserver) observers.push(longTaskObserver);
      const resourceObserver = createObserver("resource", onResourceEntries);
      if (resourceObserver) observers.push(resourceObserver);

      frameHandle = requestFrame(onFrame);
    },

    stop() {
      if (!running) return;
      running = false;
      stoppedElapsedMs = now() - startedAtMs;

      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
      if (map) {
        for (const [event, listener] of mapListeners) map.off(event, listener);
      }
      mapListeners.clear();
      map = null;
      unsubscribeStore?.();
      unsubscribeStore = null;
      for (const observer of observers) observer.disconnect();
      observers.length = 0;
      lastFrameMs = null;
    },

    reset() {
      zeroAggregates();
      lastProgress = null;
      startedAtMs = now();
      stoppedElapsedMs = 0;
    },

    snapshot() {
      const elapsedMs = running ? now() - startedAtMs : stoppedElapsedMs;
      return {
        running,
        elapsedMs: round2(elapsedMs),
        frames: {
          samples: frameSamples,
          totalMs: round2(frameTotalMs),
          estimatedFps: frameTotalMs > 0 ? round2((frameSamples * 1000) / frameTotalMs) : 0,
          longestMs: round2(frameLongestMs),
          p95Ms: round2(recentFrames.percentile(0.95)),
          over32ms: framesOver32,
          over50ms: framesOver50,
          retainedSamples: recentFrames.size,
        },
        longTasks: {
          supported: longTasksSupported,
          count: longTaskCount,
          totalMs: round2(longTaskTotalMs),
          longestMs: round2(longTaskLongestMs),
        },
        map: { ...mapCounts },
        navigation: { storeNotifications, progressPublications },
        resources: {
          tile: { ...resources.tile },
          "road-conditions": { ...resources["road-conditions"] },
          routing: { ...resources.routing },
          other: { ...resources.other },
        },
        metadata: { ...metadata },
      };
    },

    setMetadata(patch) {
      Object.assign(metadata, patch);
    },
  };
}
