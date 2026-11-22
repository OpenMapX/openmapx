import { useNavigationStore } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { act, createFakeMap, type FakeMap, render } from "@/test";

let fake: FakeMap;
const mapRef: { current: unknown } = { current: null };
const overlay = vi.hoisted(() => ({ visible: true }));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/overlay/useOverlayStoreState", () => ({
  useOverlayLayerVisible: () => overlay.visible,
}));

import { Navigation3dController } from "./Navigation3dController";

const active = () => useNavigationSceneStore.getState().active;

beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap({ maxPitch: 60, pitch: 55 });
  mapRef.current = fake.map;
  overlay.visible = true;
  useNavigationStore.setState({ status: "idle", mode: "driving" });
});

afterEach(() => {
  vi.useRealTimers();
  useNavigationStore.setState({ status: "idle", mode: "driving" });
  useNavigationSceneStore.getState().setActive(false);
});

describe("Navigation3dController", () => {
  it("activates for a driving trip with the 3D view on", () => {
    render(<Navigation3dController />);
    expect(active()).toBe(false);
    act(() => useNavigationStore.setState({ status: "navigating" }));
    expect(active()).toBe(true);
  });

  it("stays inactive for walking", () => {
    render(<Navigation3dController />);
    act(() => useNavigationStore.setState({ status: "navigating", mode: "walking" }));
    expect(active()).toBe(false);
  });

  it("stays inactive without the 3D view", () => {
    overlay.visible = false;
    render(<Navigation3dController />);
    act(() => useNavigationStore.setState({ status: "navigating" }));
    expect(active()).toBe(false);
  });

  it("raises maxPitch to 70 on activation", () => {
    render(<Navigation3dController />);
    act(() => useNavigationStore.setState({ status: "navigating" }));
    expect(fake.state.maxPitch).toBe(70);
  });

  it("restores maxPitch only after pitch eased ≤ 60", () => {
    render(<Navigation3dController />);
    act(() => useNavigationStore.setState({ status: "navigating" }));
    fake.state.pitch = 68;
    act(() => useNavigationStore.setState({ status: "idle" }));
    expect(active()).toBe(false);
    expect(fake.state.maxPitch).toBe(70);
    fake.state.pitch = 63;
    act(() => fake.emit("move"));
    expect(fake.state.maxPitch).toBe(70);
    fake.state.pitch = 59.5;
    act(() => fake.emit("move"));
    expect(fake.state.maxPitch).toBe(60);
  });

  it("restores after 3 s even if the pitch never eases", () => {
    render(<Navigation3dController />);
    act(() => useNavigationStore.setState({ status: "navigating" }));
    fake.state.pitch = 68;
    act(() => useNavigationStore.setState({ status: "idle" }));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(fake.state.maxPitch).toBe(60);
  });

  it("unmount restores maxPitch and deactivates", () => {
    const view = render(<Navigation3dController />);
    act(() => useNavigationStore.setState({ status: "navigating" }));
    fake.state.pitch = 68;
    view.unmount();
    expect(active()).toBe(false);
    expect(fake.state.maxPitch).toBe(60);
  });
});
