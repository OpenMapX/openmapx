import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/integration-api/map/layerStack";
import { act, createFakeMap, type FakeMap, render, waitFor } from "@/test";

const mapContext = vi.hoisted(() => ({ mapRef: { current: null as FakeMap["map"] | null } }));
const env = vi.hoisted(() => ({ apiUrl: "https://api.test" }));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: mapContext.mapRef, mapReady: true, styleVersion: 0 }),
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => env,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { MountainShelterLayer } from "./shelter-layer";
import { useHikingStore } from "./store";

const SOURCE_ID = "openmapx-shelters-source";
const CIRCLE_LAYER_ID = "openmapx-shelters-circles";
const LABEL_LAYER_ID = "openmapx-shelters-labels";

const SHELTERS = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Refuge du Lac", type: "refuge" },
      geometry: { type: "Point", coordinates: [6.5, 45.5] },
    },
  ],
};

let fake: FakeMap;

beforeEach(() => {
  fake = createFakeMap({ zoom: 12 });
  mapContext.mapRef.current = fake.map;
  useHikingStore.setState({ layerVisible: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useHikingStore.setState({ layerVisible: false });
});

describe("MountainShelterLayer", () => {
  it("fetches once when shown and keeps its data through a style replacement", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => SHELTERS }));
    vi.stubGlobal("fetch", fetchMock);
    render(<MountainShelterLayer />);

    await waitFor(() => expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(SHELTERS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(layerRegistrations()).toEqual(
      expect.arrayContaining([
        { id: CIRCLE_LAYER_ID, slot: "overlay-points", order: 7 },
        { id: LABEL_LAYER_ID, slot: "overlay-markers", order: 4 },
      ]),
    );

    act(() => fake.map.setStyle({} as never));
    await act(async () => {});

    expect(fake.state.layers.has(CIRCLE_LAYER_ID)).toBe(true);
    expect(fake.state.layers.has(LABEL_LAYER_ID)).toBe(true);
    expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(SHELTERS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes its layers when hidden and fetches again when shown", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => SHELTERS }));
    vi.stubGlobal("fetch", fetchMock);
    render(<MountainShelterLayer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => useHikingStore.setState({ layerVisible: false }));

    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);
    expect(fake.state.layers.has(CIRCLE_LAYER_ID)).toBe(false);
    expect(fake.state.layers.has(LABEL_LAYER_ID)).toBe(false);
    expect(layerRegistrations().some((entry) => entry.id === CIRCLE_LAYER_ID)).toBe(false);

    act(() => useHikingStore.setState({ layerVisible: true }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.state.sources.get(SOURCE_ID)?.data).toEqual(SHELTERS));
  });
});
