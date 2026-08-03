// @vitest-environment jsdom

import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavAlerts } from "./useNavAlerts";
import { useNavIncidents } from "./useNavIncidents";
import { useNavTrafficSignals } from "./useNavTrafficSignals";

const fetchRoadConditions = vi.fn();
const fetchRouteMatchWindow = vi.fn();
const fetchRoadAlerts = vi.fn();

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    fetchRoadConditions: (...args: unknown[]) => fetchRoadConditions(...args),
    fetchRouteMatchWindow: (...args: unknown[]) => fetchRouteMatchWindow(...args),
    fetchRoadAlerts: (...args: unknown[]) => fetchRoadAlerts(...args),
    useCountryFromCoordinates: () => ({ data: null }),
  };
});

const geometry: [number, number][] = [
  [13, 52],
  [13.01, 52],
];
const route = {
  distance: 700,
  duration: 90,
  geometry,
  legs: [],
  mode: "driving",
  steps: [
    {
      instruction: "Head east",
      distance: 700,
      duration: 90,
      coordinates: geometry,
      speedLimit: 50,
    },
  ],
} as never;

function startNavigation() {
  useNavigationStore.getState().startGroundNavigation(route, "driving", geometry);
}

describe("offline live-data gating", () => {
  beforeEach(() => {
    fetchRoadConditions.mockReset().mockResolvedValue([]);
    fetchRouteMatchWindow.mockReset().mockResolvedValue({
      signals: [],
      speedLimitsByPoint: [50, null],
    });
    fetchRoadAlerts.mockReset().mockResolvedValue([]);
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({
      incidentAlerts: true,
      avoidIncidents: true,
      speedCameraAlerts: true,
    });
    startNavigation();
    useNavigationStore.getState().setConnectivity("offline");
  });

  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({
      incidentAlerts: true,
      avoidIncidents: false,
      speedCameraAlerts: false,
    });
  });

  it("does not schedule incidents, route-match, or alert requests offline", async () => {
    renderHook(() => {
      useNavIncidents();
      useNavTrafficSignals();
      useNavAlerts();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchRoadConditions).not.toHaveBeenCalled();
    expect(fetchRouteMatchWindow).not.toHaveBeenCalled();
    expect(fetchRoadAlerts).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
  });

  it("clears live speed data while retaining static route-step limits", async () => {
    useNavigationStore.getState().setConnectivity("online");
    const { result } = renderHook(() => useNavTrafficSignals());
    await waitFor(() => expect(result.current).toEqual([]));
    expect(useNavigationStore.getState().liveSpeedLimits).toEqual([50, null]);

    act(() => useNavigationStore.getState().setConnectivity("offline"));
    await waitFor(() => expect(result.current).toEqual([]));
    expect(useNavigationStore.getState().liveSpeedLimits).toBeNull();
    expect(useNavigationStore.getState().route?.steps[0]?.speedLimit).toBe(50);
  });

  it("allows the live hooks to fetch again after connectivity returns", async () => {
    const { rerender } = renderHook(() => {
      useNavIncidents();
      useNavTrafficSignals();
      useNavAlerts();
    });
    expect(fetchRoadConditions).not.toHaveBeenCalled();

    act(() => useNavigationStore.getState().setConnectivity("online"));
    rerender();
    await waitFor(() => {
      expect(fetchRoadConditions).toHaveBeenCalled();
      expect(fetchRouteMatchWindow).toHaveBeenCalled();
      expect(fetchRoadAlerts).toHaveBeenCalled();
    });
  });
});
