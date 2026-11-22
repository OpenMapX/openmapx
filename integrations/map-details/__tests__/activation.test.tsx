import { useLayerStore, useNavigationStore } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { act, createFakeMap, renderHook } from "@/test";

vi.mock("@/integration-api/overlay/useOverlayStoreState", () => ({
  useOverlayLayerVisible: () => true,
}));

import { useMapDetailsActive } from "../activation";

beforeEach(() => {
  useNavigationStore.setState({ status: "idle" });
  useLayerStore.setState({ activeLayer: "default" });
});
afterEach(() => {
  useNavigationSceneStore.getState().setActive(false);
  useNavigationStore.setState({ status: "idle" });
});

describe("useMapDetailsActive", () => {
  it("is the full 3D view while browsing", () => {
    const fake = createFakeMap({ zoom: 17, pitch: 45 });
    const { result } = renderHook(() => useMapDetailsActive(fake.map as never));
    expect(result.current).toMatchObject({ active: true, mode: "full" });
  });

  it("navigation mode activates during 3D navigation", () => {
    const fake = createFakeMap({ zoom: 17, pitch: 62 });
    const { result } = renderHook(() => useMapDetailsActive(fake.map as never));
    act(() => {
      useNavigationStore.setState({ status: "navigating" });
      useNavigationSceneStore.getState().setActive(true);
    });
    expect(result.current).toMatchObject({ active: true, mode: "navigation" });
  });

  it("stays off during 2D navigation", () => {
    const fake = createFakeMap({ zoom: 17, pitch: 55 });
    const { result } = renderHook(() => useMapDetailsActive(fake.map as never));
    act(() => useNavigationStore.setState({ status: "navigating" }));
    expect(result.current.active).toBe(false);
  });
});
