import { useNavigationStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const map = vi.hoisted(() => ({ easeTo: vi.fn(), getZoom: () => 14, on: vi.fn(), off: vi.fn() }));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMapOptional: () => ({ mapRef: { current: map }, mapReady: true }),
}));

vi.mock("@/lib/cameraPadding", () => ({
  getCameraPaddingTarget: () => ({ top: 250, bottom: 90, left: 16, right: 16 }),
  subscribeCameraPaddingTarget: () => () => {},
}));

import { useTransitFollowCamera } from "./useTransitFollowCamera";

afterEach(() => {
  useNavigationStore.getState().stopNavigation();
  vi.clearAllMocks();
});
it("follows the raw transit position in either authority and releases follow for a user pan", () => {
  useNavigationStore.setState({
    kind: "transit",
    status: "navigating",
    navigationAuthority: "native",
    cameraMode: "follow",
    transitProgress: {
      currentLegIndex: 0,
      phase: "riding",
      position: [8, 50],
      snapped: [9, 51],
      positionTimestampMs: Date.now(),
      fractionAlongLeg: 0,
      deviationMeters: 200,
      arrived: false,
    },
  });
  renderHook(() => useTransitFollowCamera());
  expect(map.easeTo).toHaveBeenCalledWith(
    expect.objectContaining({
      center: [8, 50],
      padding: { top: 250, bottom: 90, left: 16, right: 16 },
    }),
    {
      programmatic: true,
    },
  );
  const drag = map.on.mock.calls.find((c) => c[0] === "dragstart")?.[1] as () => void;
  act(() => drag());
  expect(useNavigationStore.getState().cameraMode).toBe("free");
});
