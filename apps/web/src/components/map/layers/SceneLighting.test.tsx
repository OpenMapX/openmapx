import {
  createOverlayStore,
  getRegisteredOverlayStore,
  type OverlayStoreBase,
  registerOverlayEntry,
  runOverlayTransaction,
  setOverlayLayerVisible,
  useLayerStore,
} from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEUTRAL_SCENE_LIGHT,
  NIGHT_SCENE_LIGHT,
  useSceneLightStore,
} from "@/integration-api/map/sceneLight";
import { createFakeMap, type FakeMap } from "@/test";

const sun = vi.hoisted(() => ({ altitude: 30, altitudeCalls: 0 }));
const scheme = vi.hoisted(() => ({ mode: "light" as "light" | "dark" }));
const device = vi.hoisted(() => ({ mobile: false }));
const weather = vi.hoisted(() => ({
  data: undefined as unknown,
  enabled: [] as boolean[],
}));

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  solarAltitudeDeg: () => {
    sun.altitudeCalls += 1;
    return sun.altitude;
  },
  solarAzimuthDeg: () => 180,
}));
vi.mock("@mui/material/styles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mui/material/styles")>()),
  useColorScheme: () => ({ mode: scheme.mode, systemMode: undefined }),
}));
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => device.mobile }));
vi.mock("@/components/weather/useMapCenterWeather", () => ({
  useMapCenterWeather: ({ enabled }: { enabled: boolean }) => {
    weather.enabled.push(enabled);
    return { data: enabled ? weather.data : undefined, zoom: 10 };
  },
}));

let fake: FakeMap;
let context: { mapRef: { current: FakeMap["map"] }; mapReady: boolean; styleVersion: number };
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => context }));

import { SceneLighting } from "./SceneLighting";

const FALLBACK: OverlayStoreBase = {
  panelOpen: false,
  layerVisible: false,
  userRevision: 0,
  openPanel: () => {},
  closePanel: () => {},
  setLayerVisible: () => {},
};

function registerOverlay(id: string) {
  createOverlayStore({ overlayId: id, extra: {} });
  registerOverlayEntry({
    id,
    getState: () => getRegisteredOverlayStore(id)?.getState() ?? FALLBACK,
    useActive: () => false,
    excludes: [],
  });
}

function setThreeD(visible: boolean) {
  act(() => setOverlayLayerVisible("3d-buildings", visible, { kind: "user" }));
}

const intervals = () =>
  vi.mocked(setInterval).mock.calls.filter(([, delay]) => delay === 60_000).length;

beforeAll(() => {
  registerOverlay("sun-time");
  registerOverlay("3d-buildings");
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, "setInterval");
  fake = createFakeMap({ styleLoaded: true });
  fake.state.center = { lng: 8, lat: 50 } as never;
  context = { mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 };
  sun.altitude = 30;
  sun.altitudeCalls = 0;
  scheme.mode = "light";
  device.mobile = false;
  weather.data = undefined;
  weather.enabled = [];
  useSceneLightStore.setState({ light: NEUTRAL_SCENE_LIGHT });
  useLayerStore.setState({ globeView: false, globeLighting: true, activeLayer: "default" });
  setThreeD(false);
});

afterEach(() => {
  act(() => runOverlayTransaction("sun-time", { panelOpen: false }, { kind: "user" }));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SceneLighting", () => {
  it("applies a map-anchored light once the style has loaded", () => {
    render(<SceneLighting />);
    expect(fake.state.light).toMatchObject({ anchor: "map", color: "#fffbf5" });
    expect(useSceneLightStore.getState().light.preset).toBe("day");
  });

  it("re-applies the light after a style reload", () => {
    render(<SceneLighting />);
    act(() => fake.map.setStyle({} as never));
    expect(fake.state.light).toMatchObject({ anchor: "map", color: "#fffbf5" });
  });

  it("defers a light change made while the style is loading", () => {
    render(<SceneLighting />);
    const style = fake.map.getStyle;
    fake.state.styleLoaded = false;
    act(() => fake.emit("styledataloading"));
    Object.assign(fake.map, { getStyle: () => undefined });

    scheme.mode = "dark";
    expect(() => act(() => useLayerStore.setState({ activeLayer: "terrain" }))).not.toThrow();
    expect(fake.state.light).toMatchObject({ color: "#fffbf5" });

    fake.state.styleLoaded = true;
    Object.assign(fake.map, { getStyle: style });
    act(() => fake.emit("style.load"));
    expect(fake.state.light).toMatchObject({ color: "#e4e9f5" });
  });

  it("lights the dark theme as night", () => {
    scheme.mode = "dark";
    render(<SceneLighting />);
    expect(useSceneLightStore.getState().light).toEqual(NIGHT_SCENE_LIGHT);
  });

  it("falls back to the neutral light while Daylight and time zones is open", () => {
    act(() => runOverlayTransaction("sun-time", { panelOpen: true }, { kind: "user" }));
    render(<SceneLighting />);
    expect(useSceneLightStore.getState().light).toEqual(NEUTRAL_SCENE_LIGHT);
  });

  it("runs no timer in the plain 2D map", () => {
    render(<SceneLighting />);
    expect(intervals()).toBe(0);
  });

  it("runs no timer at night", () => {
    scheme.mode = "dark";
    setThreeD(true);
    render(<SceneLighting />);
    expect(intervals()).toBe(0);
  });

  it("moves the sun on once a minute in the 3D view, and not while hidden", () => {
    setThreeD(true);
    render(<SceneLighting />);
    expect(intervals()).toBe(1);

    sun.altitude = 2;
    act(() => vi.advanceTimersByTime(60_000));
    expect(useSceneLightStore.getState().light.preset).toBe("golden");

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    sun.altitude = -4;
    act(() => vi.advanceTimersByTime(60_000));
    expect(useSceneLightStore.getState().light.preset).toBe("golden");

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(useSceneLightStore.getState().light.preset).toBe("dusk");
  });

  it("ignores moves under a quarter degree", () => {
    setThreeD(true);
    render(<SceneLighting />);
    const calls = sun.altitudeCalls;

    fake.state.center = { lng: 8.1, lat: 50 } as never;
    act(() => fake.emit("moveend"));
    expect(sun.altitudeCalls).toBe(calls);

    fake.state.center = { lng: 8.3, lat: 50 } as never;
    act(() => fake.emit("moveend"));
    expect(sun.altitudeCalls).toBeGreaterThan(calls);
  });

  it("keeps the overcast light while the next cell's weather loads", () => {
    weather.data = { current: { cloudCover: 100, weatherCode: 3 } };
    setThreeD(true);
    render(<SceneLighting />);
    const overcast = useSceneLightStore.getState().light;
    expect(overcast.intensity).toBeLessThan(0.4);

    // Panning into an uncached cell leaves the query without data for a moment.
    weather.data = undefined;
    act(() => useLayerStore.setState({ activeLayer: "terrain" }));
    expect(useSceneLightStore.getState().light).toBe(overcast);
  });

  it("dims for an overcast sky on desktop only", () => {
    weather.data = { current: { cloudCover: 100, weatherCode: 3 } };
    setThreeD(true);
    const { unmount } = render(<SceneLighting />);
    expect(weather.enabled.at(-1)).toBe(true);
    expect(useSceneLightStore.getState().light.intensity).toBeLessThan(0.4);
    unmount();

    device.mobile = true;
    useSceneLightStore.setState({ light: NEUTRAL_SCENE_LIGHT });
    render(<SceneLighting />);
    expect(weather.enabled.at(-1)).toBe(false);
    expect(useSceneLightStore.getState().light.intensity).toBe(0.4);
  });
});
