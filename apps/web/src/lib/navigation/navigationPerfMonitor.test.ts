import { describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import {
  createNavigationPerfMonitor,
  type NavPerfObserverFactory,
  type NavPerfPerformanceEntry,
} from "./navigationPerfMonitor";

interface FakeFrames {
  request: (cb: (timestampMs: number) => void) => number;
  cancel: (handle: number) => void;
  /** Run the single pending frame callback at `timestampMs`. */
  tick: (timestampMs: number) => void;
  pending: () => number;
  cancelled: () => number;
}

function fakeFrames(): FakeFrames {
  let handle = 0;
  let cancelled = 0;
  const queue = new Map<number, (t: number) => void>();
  return {
    request: (cb) => {
      handle += 1;
      queue.set(handle, cb);
      return handle;
    },
    cancel: (h) => {
      cancelled += 1;
      queue.delete(h);
    },
    tick: (timestampMs) => {
      const entries = [...queue.entries()];
      queue.clear();
      for (const [, cb] of entries) cb(timestampMs);
    },
    pending: () => queue.size,
    cancelled: () => cancelled,
  };
}

function fakeStore() {
  let listener: ((state: { progress: unknown }) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  return {
    store: {
      subscribe(l: (state: { progress: unknown }) => void) {
        listener = l;
        return unsubscribe;
      },
    },
    unsubscribe,
    publish: (progress: unknown) => listener?.({ progress }),
    subscribed: () => listener !== null,
  };
}

function fakeObservers(unsupported: string[] = []) {
  const created: Array<{
    entryType: string;
    emit: (entries: NavPerfPerformanceEntry[]) => void;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const factory: NavPerfObserverFactory = (entryType, onEntries) => {
    if (unsupported.includes(entryType)) return null;
    const disconnect = vi.fn();
    created.push({ entryType, emit: onEntries, disconnect });
    return { disconnect };
  };
  return {
    factory,
    created,
    emit: (entryType: string, entries: NavPerfPerformanceEntry[]) => {
      for (const o of created) if (o.entryType === entryType) o.emit(entries);
    },
  };
}

function setup(options: { unsupported?: string[] } = {}) {
  let clock = 0;
  const frames = fakeFrames();
  const observers = fakeObservers(options.unsupported);
  const monitor = createNavigationPerfMonitor({
    now: () => clock,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    createObserver: observers.factory,
  });
  const fake = createFakeMap();
  const store = fakeStore();
  return {
    monitor,
    frames,
    observers,
    fake,
    store,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const resourceEntry = (name: string, over: Partial<NavPerfPerformanceEntry> = {}) => ({
  entryType: "resource",
  name,
  duration: 10,
  transferSize: 100,
  encodedBodySize: 80,
  ...over,
});

describe("navigationPerfMonitor", () => {
  it("creates no listeners, observers or frame callbacks before start", () => {
    const { monitor, frames, observers, fake, store } = setup();
    expect(frames.pending()).toBe(0);
    expect(observers.created).toHaveLength(0);
    expect(fake.state.handlers.size).toBe(0);
    expect(store.subscribed()).toBe(false);
    expect(monitor.snapshot().running).toBe(false);
  });

  it("attaches exactly one listener per map event and one store subscription", () => {
    const { monitor, fake, store, observers } = setup();
    monitor.start(fake.map, store.store);
    for (const event of ["render", "move", "moveend", "idle"]) {
      expect(fake.state.handlers.get(event)?.size).toBe(1);
    }
    expect(store.subscribed()).toBe(true);
    expect(observers.created.map((o) => o.entryType).sort()).toEqual(["longtask", "resource"]);
    monitor.stop();
  });

  it("does not multiply listeners across repeated start/stop cycles", () => {
    const { monitor, fake, store, observers } = setup();
    for (let i = 0; i < 5; i += 1) {
      monitor.start(fake.map, store.store);
      monitor.stop();
    }
    monitor.start(fake.map, store.store);
    expect(fake.state.handlers.get("render")?.size).toBe(1);
    expect(observers.created.filter((o) => o.entryType === "resource")).toHaveLength(6);
    monitor.stop();
    for (const event of ["render", "move", "moveend", "idle"]) {
      expect(fake.state.handlers.get(event)?.size ?? 0).toBe(0);
    }
    expect(store.subscribed()).toBe(false);
    for (const observer of observers.created) expect(observer.disconnect).toHaveBeenCalled();
  });

  it("ignores a second start while already running", () => {
    const { monitor, fake, store } = setup();
    monitor.start(fake.map, store.store);
    monitor.start(fake.map, store.store);
    expect(fake.state.handlers.get("render")?.size).toBe(1);
    monitor.stop();
  });

  it("stops idempotently", () => {
    const { monitor, fake, store, frames } = setup();
    monitor.start(fake.map, store.store);
    monitor.stop();
    const cancelledOnce = frames.cancelled();
    monitor.stop();
    monitor.stop();
    expect(frames.cancelled()).toBe(cancelledOnce);
    expect(store.unsubscribe).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().running).toBe(false);
  });

  it("counts map events only while running", () => {
    const { monitor, fake, store } = setup();
    monitor.start(fake.map, store.store);
    fake.emit("render");
    fake.emit("render");
    fake.emit("move");
    fake.emit("moveend");
    fake.emit("idle");
    expect(monitor.snapshot().map).toEqual({ render: 2, move: 1, moveend: 1, idle: 1 });
    monitor.stop();
    fake.emit("render");
    expect(monitor.snapshot().map.render).toBe(2);
  });

  it("counts progress publications only when the progress reference changes", () => {
    const { monitor, fake, store } = setup();
    monitor.start(fake.map, store.store);
    const progress = { alongMeters: 1 };
    store.publish(progress);
    store.publish(progress);
    store.publish({ alongMeters: 2 });
    const snap = monitor.snapshot();
    expect(snap.navigation.storeNotifications).toBe(3);
    expect(snap.navigation.progressPublications).toBe(2);
    monitor.stop();
  });

  it("derives deterministic frame aggregates from frame timestamps", () => {
    const { monitor, fake, store, frames } = setup();
    monitor.start(fake.map, store.store);
    // First frame only seeds the clock; deltas: 16, 40, 60, 16 ms.
    for (const t of [0, 16, 56, 116, 132]) frames.tick(t);
    const f = monitor.snapshot().frames;
    expect(f.samples).toBe(4);
    expect(f.totalMs).toBe(132);
    expect(f.longestMs).toBe(60);
    expect(f.over32ms).toBe(2);
    expect(f.over50ms).toBe(1);
    // 4 samples over 132 ms.
    expect(f.estimatedFps).toBeCloseTo(30.3, 1);
    monitor.stop();
  });

  it("keeps retained frame samples bounded at 10,000 frames", () => {
    const { monitor, fake, store, frames } = setup();
    monitor.start(fake.map, store.store);
    for (let i = 0; i <= 10_000; i += 1) frames.tick(i * 16);
    const f = monitor.snapshot().frames;
    expect(f.samples).toBe(10_000);
    expect(f.retainedSamples).toBe(1000);
    expect(JSON.stringify(monitor.snapshot()).length).toBeLessThan(4000);
    monitor.stop();
  });

  it("aggregates long tasks when the entry type is supported", () => {
    const { monitor, fake, store, observers } = setup();
    monitor.start(fake.map, store.store);
    observers.emit("longtask", [
      { entryType: "longtask", name: "self", duration: 120 },
      { entryType: "longtask", name: "self", duration: 60 },
    ]);
    const lt = monitor.snapshot().longTasks;
    expect(lt.supported).toBe(true);
    expect(lt.count).toBe(2);
    expect(lt.totalMs).toBe(180);
    expect(lt.longestMs).toBe(120);
    monitor.stop();
  });

  it("degrades cleanly when an entry type is unsupported", () => {
    const { monitor, fake, store } = setup({ unsupported: ["longtask"] });
    expect(() => monitor.start(fake.map, store.store)).not.toThrow();
    const snap = monitor.snapshot();
    expect(snap.longTasks.supported).toBe(false);
    expect(snap.longTasks.count).toBe(0);
    monitor.stop();
  });

  it("classifies resources into coarse categories and never retains the URL", () => {
    const { monitor, fake, store, observers } = setup();
    monitor.start(fake.map, store.store);
    observers.emit("resource", [
      resourceEntry("https://api.maptiler.com/tiles/v3/14/8800/5373.pbf?key=secret"),
      resourceEntry("https://tiles.example.org/styles/v2/12/2200/1343.png"),
      resourceEntry("https://api.openmapx.com/road-conditions/segments?bbox=13.4050,52.5200"),
      resourceEntry("https://api.openmapx.com/routing/route?points=13.4050,52.5200"),
      resourceEntry("https://api.openmapx.com/places/details?id=abc"),
    ]);
    const snap = monitor.snapshot();
    expect(snap.resources.tile.count).toBe(2);
    expect(snap.resources["road-conditions"].count).toBe(1);
    expect(snap.resources.routing.count).toBe(1);
    expect(snap.resources.other.count).toBe(1);
    expect(snap.resources.tile.transferBytes).toBe(200);
    expect(snap.resources.tile.encodedBytes).toBe(160);
    expect(snap.resources.tile.totalDurationMs).toBe(20);

    const json = JSON.stringify(snap);
    expect(json).not.toContain("http");
    expect(json).not.toContain("maptiler");
    expect(json).not.toContain("52.5200");
    expect(json).not.toContain("secret");
    monitor.stop();
  });

  it("tolerates resource entries without size fields", () => {
    const { monitor, fake, store, observers } = setup();
    monitor.start(fake.map, store.store);
    observers.emit("resource", [
      {
        entryType: "resource",
        name: "https://api.openmapx.com/x",
        duration: 5,
      },
    ]);
    expect(monitor.snapshot().resources.other).toEqual({
      count: 1,
      totalDurationMs: 5,
      transferBytes: 0,
      encodedBytes: 0,
    });
    monitor.stop();
  });

  it("reset() zeroes aggregates but keeps running", () => {
    const { monitor, fake, store, frames, advance } = setup();
    monitor.start(fake.map, store.store);
    fake.emit("render");
    frames.tick(0);
    frames.tick(16);
    advance(500);
    monitor.reset();
    const snap = monitor.snapshot();
    expect(snap.running).toBe(true);
    expect(snap.map.render).toBe(0);
    expect(snap.frames.samples).toBe(0);
    expect(snap.elapsedMs).toBe(0);
    fake.emit("render");
    expect(monitor.snapshot().map.render).toBe(1);
    monitor.stop();
  });

  it("tracks elapsed time from the injected clock", () => {
    const { monitor, fake, store, advance } = setup();
    monitor.start(fake.map, store.store);
    advance(2500);
    expect(monitor.snapshot().elapsedMs).toBe(2500);
    monitor.stop();
    advance(1000);
    expect(monitor.snapshot().elapsedMs).toBe(2500);
  });

  it("carries manually entered test metadata into the snapshot", () => {
    const { monitor } = setup();
    monitor.setMetadata({ deviceModel: "Pixel 7a", scenario: "city" });
    monitor.setMetadata({ buildSha: "abc1234" });
    expect(monitor.snapshot().metadata).toMatchObject({
      deviceModel: "Pixel 7a",
      scenario: "city",
      buildSha: "abc1234",
      browserVersion: "",
    });
  });

  it("survives start() without a map or a store", () => {
    const { monitor, frames } = setup();
    monitor.start(null, null);
    frames.tick(0);
    frames.tick(20);
    expect(monitor.snapshot().frames.samples).toBe(1);
    monitor.stop();
  });
});
