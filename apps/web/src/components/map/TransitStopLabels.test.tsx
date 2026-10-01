import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { render } from "@/test";
import { TransitStopLabels } from "./TransitStopLabels";

const context = vi.hoisted(() => ({
  mapRef: { current: null as unknown },
  mapReady: true,
  styleVersion: 0,
}));
const published = vi.hoisted(() => ({ groups: [] as (MapLayerGroup | null)[] }));

vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => context }));
vi.mock("@/integration-api/map/useMapLayerGroup", () => ({
  useMapLayerGroup: (group: MapLayerGroup | null) => published.groups.push(group),
}));
vi.mock("next-intl", () => ({ useLocale: () => "en" }));
vi.mock("@mui/material/styles", () => ({
  useColorScheme: () => ({ mode: "light", systemMode: "light" }),
}));

type Handler = (event?: unknown) => void;

function poi(id: number, properties: Record<string, unknown>, coordinates: [number, number]) {
  return { id, geometry: { type: "Point", coordinates }, properties };
}

function fakeMap(features: ReturnType<typeof poi>[], hasBasemap = true) {
  const handlers = new Map<string, Handler[]>();
  return {
    getSource: (id: string) => (id === "openmaptiles" && hasBasemap ? {} : undefined),
    querySourceFeatures: () => features,
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

let frames: FrameRequestCallback[] = [];

async function nextFrame() {
  await act(async () => {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  });
}

describe("TransitStopLabels", () => {
  beforeEach(() => {
    published.groups = [];
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
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
});
