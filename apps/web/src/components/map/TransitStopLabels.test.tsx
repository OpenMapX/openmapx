import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { render } from "@/test";
import { TransitStopLabels } from "./TransitStopLabels";

const context = vi.hoisted(() => ({
  mapRef: { current: null as unknown },
  mapReady: true,
  styleVersion: 0,
  locale: "en",
}));
const published = vi.hoisted(() => ({ groups: [] as (MapLayerGroup | null)[] }));

vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => context }));
vi.mock("@/integration-api/map/useMapLayerGroup", () => ({
  useMapLayerGroup: (group: MapLayerGroup | null) => published.groups.push(group),
}));
vi.mock("next-intl", () => ({ useLocale: () => context.locale }));
vi.mock("@mui/material/styles", () => ({
  useColorScheme: () => ({ mode: "light", systemMode: "light" }),
}));

type Handler = (event?: unknown) => void;

function poi(id: number, properties: Record<string, unknown>, coordinates: [number, number]) {
  return { id, geometry: { type: "Point", coordinates }, properties };
}

function fakeMap(features: ReturnType<typeof poi>[], hasBasemap = true) {
  let zoom = 16;
  const handlers = new Map<string, Handler[]>();
  return {
    getSource: (id: string) => (id === "openmaptiles" && hasBasemap ? {} : undefined),
    querySourceFeatures: vi.fn(() => features),
    getZoom: () => zoom,
    setZoom: (next: number) => {
      zoom = next;
    },
    on: (type: string, handler: Handler) =>
      handlers.set(type, [...(handlers.get(type) ?? []), handler]),
    off: (type: string, handler: Handler) =>
      handlers.set(
        type,
        (handlers.get(type) ?? []).filter((candidate) => candidate !== handler),
      ),
    fire: (type: string, event?: unknown) => {
      for (const handler of handlers.get(type) ?? []) handler(event);
    },
  };
}

function lastGroup() {
  return published.groups.at(-1) ?? null;
}

function labelledNames() {
  const source = lastGroup()?.sources["transit-stop-labels"] as
    | { data: { features: { properties: { name: string; nearStation: boolean } }[] } }
    | undefined;
  return source?.data.features.map((feature) => [
    feature.properties.name,
    feature.properties.nearStation,
  ]);
}

let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

async function nextFrame() {
  await act(async () => {
    const pending = frames;
    frames = new Map();
    for (const callback of pending.values()) callback(0);
  });
}

describe("TransitStopLabels", () => {
  beforeEach(() => {
    published.groups = [];
    frames = new Map();
    nextFrameId = 0;
    context.locale = "en";
    context.styleVersion = 0;
    context.mapReady = true;
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("labels each stop once and marks the ones a station already names", async () => {
    context.mapRef.current = fakeMap([
      poi(
        1,
        { class: "bus", subclass: "bus_stop", name: "S+U Alexanderplatz/Memhardstraße", rank: 4 },
        [13.4116, 52.5237],
      ),
      poi(
        2,
        {
          class: "railway",
          subclass: "tram_stop",
          name: "S+U Alexanderplatz/Memhardstraße",
          rank: 2,
        },
        [13.4108, 52.5233],
      ),
      poi(
        3,
        { class: "bus", subclass: "bus_stop", name: "Jüdenstraße", rank: 2 },
        [13.4093, 52.5179],
      ),
      poi(
        4,
        { class: "railway", subclass: "station", name: "Alexanderplatz", rank: 7 },
        [13.4115, 52.5219],
      ),
      // Underground platforms have no icon on the map to name.
      poi(
        5,
        { class: "bus", subclass: "bus_stop", name: "Tunnel", rank: 1, level: -1 },
        [13.41, 52.52],
      ),
      poi(6, { class: "restaurant", name: "Nordsee", rank: 1 }, [13.41, 52.52]),
    ]);
    render(<TransitStopLabels />);
    await nextFrame();

    expect(labelledNames()).toEqual([
      ["S+U Alexanderplatz/Memhardstraße", true],
      ["Jüdenstraße", false],
    ]);
    expect(lastGroup()?.layers[0]).toMatchObject({
      id: "poi-transit-stop-labels",
      slot: "overlay-markers",
      source: "transit-stop-labels",
    });
  });

  it("draws nothing on a style without basemap tiles to read", async () => {
    context.mapRef.current = fakeMap([], false);
    render(<TransitStopLabels />);
    await nextFrame();
    expect(lastGroup()).toBeNull();
  });

  it("reads the tiles again once the map settles somewhere new", async () => {
    const features: ReturnType<typeof poi>[] = [];
    const map = fakeMap(features);
    context.mapRef.current = map;
    render(<TransitStopLabels />);
    await nextFrame();
    expect(lastGroup()).toBeNull();

    features.push(
      poi(
        3,
        { class: "bus", subclass: "bus_stop", name: "Jüdenstraße", rank: 2 },
        [13.4093, 52.5179],
      ),
    );
    map.fire("moveend");
    await nextFrame();
    expect(labelledNames()).toEqual([["Jüdenstraße", false]]);
  });
  it("bounds follow-camera work across frames, retaining a trailing refresh", async () => {
    const features = [poi(1, { class: "bus", name: "First", rank: 1 }, [13.4, 52.5])];
    const map = fakeMap(features);
    context.mapRef.current = map;
    render(<TransitStopLabels />);
    await nextFrame();
    for (let i = 0; i < 60; i++) {
      map.fire("moveend", { programmatic: true });
      map.fire("sourcedata", {
        sourceId: "openmaptiles",
        sourceDataType: "idle",
        isSourceLoaded: true,
      });
      await act(async () => vi.advanceTimersByTime(16));
      await nextFrame();
    }
    expect(map.querySourceFeatures.mock.calls.length).toBeLessThanOrEqual(5);
    features.push(poi(2, { class: "bus", name: "Last", rank: 2 }, [13.5, 52.5]));
    await act(async () => vi.advanceTimersByTime(250));
    await nextFrame();
    expect(labelledNames()).toEqual([
      ["First", false],
      ["Last", false],
    ]);
    expect(map.querySourceFeatures.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("skips invisible labels and refreshes immediately at zoom threshold crossings", async () => {
    const map = fakeMap([poi(1, { class: "bus", name: "Stop", rank: 1 }, [13.4, 52.5])]);
    map.setZoom(15.9);
    context.mapRef.current = map;
    render(<TransitStopLabels />);
    await nextFrame();
    for (let i = 0; i < 10; i++) {
      map.fire("moveend", { programmatic: true });
      map.fire("sourcedata", {
        sourceId: "openmaptiles",
        sourceDataType: "content",
        isSourceLoaded: true,
      });
      await nextFrame();
    }
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    map.setZoom(16);
    map.fire("zoom");
    await nextFrame();
    expect(labelledNames()).toEqual([["Stop", false]]);
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(1);
    map.setZoom(15.9);
    map.fire("zoom");
    await nextFrame();
    expect(lastGroup()).toBeNull();
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(1);
    map.setZoom(16);
    map.fire("moveend", { programmatic: true });
    await nextFrame();
    expect(labelledNames()).toEqual([["Stop", false]]);
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("bounds tile bursts with isSourceLoaded=%s", async (isSourceLoaded) => {
    const features: ReturnType<typeof poi>[] = [];
    const map = fakeMap(features);
    context.mapRef.current = map;
    render(<TransitStopLabels />);
    await nextFrame();
    for (let i = 0; i < 20; i++) {
      features.push(poi(i, { class: "bus", name: `Stop ${i}`, rank: i }, [13.4, 52.5]));
      map.fire("sourcedata", { sourceId: "openmaptiles", coord: {}, tile: {}, isSourceLoaded });
      await act(async () => vi.advanceTimersByTime(16));
      await nextFrame();
    }
    await act(async () => vi.advanceTimersByTime(250));
    await nextFrame();
    expect(labelledNames()).toHaveLength(20);
    expect(map.querySourceFeatures.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("ignores unrelated, idle and visibility source events", async () => {
    const map = fakeMap([]);
    context.mapRef.current = map;
    render(<TransitStopLabels />);
    await nextFrame();
    for (const event of [
      { sourceId: "other", sourceDataType: "content" },
      { sourceId: "openmaptiles", sourceDataType: "visibility" },
      { sourceId: "openmaptiles", sourceDataType: "idle" },
    ]) {
      map.fire("sourcedata", { ...event, isSourceLoaded: true });
      await nextFrame();
    }
    await act(async () => vi.advanceTimersByTime(500));
    await nextFrame();
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(1);
  });

  it("refreshes user movement immediately even inside the camera cooldown", async () => {
    const features: ReturnType<typeof poi>[] = [];
    const map = fakeMap(features);
    context.mapRef.current = map;
    render(<TransitStopLabels />);
    await nextFrame();
    features.push(poi(1, { class: "bus", name: "User stop", rank: 1 }, [13.4, 52.5]));
    map.fire("moveend");
    await nextFrame();
    expect(labelledNames()).toEqual([["User stop", false]]);
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(2);
  });

  it("refreshes locale and style changes and clears labels without a basemap", async () => {
    const features = [
      poi(1, { class: "bus", name: "English", "name:de": "Deutsch", rank: 1 }, [13.4, 52.5]),
    ];
    const map = fakeMap(features);
    context.mapRef.current = map;
    const view = render(<TransitStopLabels />);
    await nextFrame();
    context.locale = "de";
    view.rerender(<TransitStopLabels />);
    await nextFrame();
    expect(labelledNames()).toEqual([["Deutsch", false]]);
    map.fire("moveend", { programmatic: true });
    context.mapRef.current = fakeMap([], false);
    context.styleVersion++;
    view.rerender(<TransitStopLabels />);
    await nextFrame();
    expect(lastGroup()).toBeNull();
    map.fire("moveend");
    await act(async () => vi.advanceTimersByTime(500));
    await nextFrame();
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(2);
    context.mapRef.current = map;
    context.styleVersion++;
    view.rerender(<TransitStopLabels />);
    await nextFrame();
    expect(labelledNames()).toEqual([["Deutsch", false]]);
  });

  it("cancels pending frames, timers and listeners on teardown", async () => {
    const map = fakeMap([]);
    context.mapRef.current = map;
    const view = render(<TransitStopLabels />);
    await nextFrame();
    map.fire("moveend", { programmatic: true });
    view.unmount();
    map.fire("moveend");
    map.fire("sourcedata", {
      sourceId: "openmaptiles",
      sourceDataType: "content",
      isSourceLoaded: true,
    });
    await act(async () => vi.advanceTimersByTime(500));
    await nextFrame();
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(1);
  });

  it("waits for map readiness and cancels an initial frame on teardown", async () => {
    const map = fakeMap([poi(1, { class: "bus", name: "Ready", rank: 1 }, [13.4, 52.5])]);
    context.mapRef.current = map;
    context.mapReady = false;
    const view = render(<TransitStopLabels />);
    await nextFrame();
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    context.mapReady = true;
    view.rerender(<TransitStopLabels />);
    await nextFrame();
    expect(labelledNames()).toEqual([["Ready", false]]);
    view.unmount();
    const next = render(<TransitStopLabels />);
    next.unmount();
    await nextFrame();
    expect(map.querySourceFeatures).toHaveBeenCalledTimes(1);
  });
  it.each(["metadata", "content"])(
    "refreshes source %s changes without a tile coordinate",
    async (sourceDataType) => {
      const features: ReturnType<typeof poi>[] = [];
      const map = fakeMap(features);
      context.mapRef.current = map;
      render(<TransitStopLabels />);
      await nextFrame();
      features.push(poi(1, { class: "bus", name: "New content", rank: 1 }, [13.4, 52.5]));
      map.fire("sourcedata", { sourceId: "openmaptiles", sourceDataType, isSourceLoaded: true });
      await act(async () => vi.advanceTimersByTime(250));
      await nextFrame();
      expect(labelledNames()).toEqual([["New content", false]]);
      expect(map.querySourceFeatures).toHaveBeenCalledTimes(2);
    },
  );
});
