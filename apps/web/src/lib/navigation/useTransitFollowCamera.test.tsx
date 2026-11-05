import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const map = vi.hoisted(() => ({
  easeTo: vi.fn(),
  getZoom: vi.fn(() => 14),
  getBearing: () => 0,
  getCanvas: () => ({ clientHeight: 900 }),
  on: vi.fn(),
  off: vi.fn(),
}));
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
  useSettingsStore.setState({ mapNorthUp: true });
  map.getZoom.mockReturnValue(14);
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

function walkingProgress() {
  const p = useNavigationStore.getState().transitProgress;
  if (!p) throw Error("Expected walking progress");
  return p;
}
function startWalking() {
  useSettingsStore.setState({ mapNorthUp: false });
  useNavigationStore.setState({
    kind: "transit",
    status: "navigating",
    cameraMode: "follow",
    itinerary: {
      legs: [
        {
          mode: "walking",
          geometry: {
            coordinates: [
              [0, 0],
              [0.01, 0],
            ],
          },
        },
      ],
    } as never,
    transitProgress: {
      currentLegIndex: 0,
      phase: "walking",
      position: [0.001, 0],
      positionTimestampMs: Date.now(),
      snapped: [0.001, 0],
      fractionAlongLeg: 0.1,
      deviationMeters: 0,
      confidence: "gps",
      arrived: false,
    },
  });
}
it("uses a close course-up walking view while keeping raw GPS as the center", () => {
  startWalking();
  renderHook(() => useTransitFollowCamera());
  expect(map.easeTo).toHaveBeenLastCalledWith(
    expect.objectContaining({
      center: [0.001, 0],
      zoom: 17,
      bearing: 90,
      pitch: 0,
      padding: { top: 474, bottom: 90, left: 16, right: 16 },
    }),
    { programmatic: true },
  );
});
it("honors north-up and does not rotate toward a distant walking line", () => {
  startWalking();
  useSettingsStore.setState({ mapNorthUp: true });
  renderHook(() => useTransitFollowCamera());
  expect(map.easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ bearing: 0 }), {
    programmatic: true,
  });
  act(() => {
    useSettingsStore.setState({ mapNorthUp: false });
    useNavigationStore.setState(() => ({
      transitProgress: {
        ...walkingProgress(),
        position: [0.003, 0.01],
        deviationMeters: 200,
        confidence: "uncertain",
      },
    }));
  });
  expect(map.easeTo).toHaveBeenLastCalledWith(
    expect.objectContaining({ center: [0.003, 0.01], bearing: 0 }),
    { programmatic: true },
  );
});
it("does not interrupt a pinch and resumes on the latest position at the user's zoom", async () => {
  vi.useFakeTimers();
  try {
    startWalking();
    renderHook(() => useTransitFollowCamera());
    map.easeTo.mockClear();
    const emit = (event: string) =>
      (map.on.mock.calls.find((c) => c[0] === event)?.[1] as (event?: unknown) => void)?.({});
    act(() => {
      emit("touchstart");
      emit("zoomstart");
    });
    act(() =>
      useNavigationStore.setState(() => ({
        transitProgress: {
          ...walkingProgress(),
          position: [0.002, 0],
          positionTimestampMs: Date.now(),
        },
      })),
    );
    expect(map.easeTo).not.toHaveBeenCalled();
    map.getZoom.mockReturnValue(18);
    act(() => emit("touchend"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ center: [0.002, 0], zoom: 18 }),
      { programmatic: true },
    );
  } finally {
    vi.useRealTimers();
  }
});

it("returns to north-up ride framing at boarding and refuses stale position updates", () => {
  startWalking();
  renderHook(() => useTransitFollowCamera());
  act(() =>
    useNavigationStore.setState({
      transitProgress: { ...walkingProgress(), currentLegIndex: 1, phase: "waiting-to-board" },
    }),
  );
  expect(map.easeTo).toHaveBeenLastCalledWith(
    expect.objectContaining({
      zoom: 15,
      bearing: 0,
      padding: { top: 250, bottom: 90, left: 16, right: 16 },
    }),
    { programmatic: true },
  );
  map.easeTo.mockClear();
  act(() =>
    useNavigationStore.setState({
      transitProgress: { ...walkingProgress(), positionTimestampMs: Date.now() - 31000 },
    }),
  );
  expect(map.easeTo).not.toHaveBeenCalled();
});
