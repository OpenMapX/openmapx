// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavIncidents } from "./useNavIncidents";

// Minimal two-point route at the equator (~444 m east).
const geometry: [number, number][] = [
  [0, 0],
  [0.004, 0],
];
const route = {
  distance: 444,
  duration: 60,
  geometry,
  legs: [],
  mode: "driving",
  steps: [{ instruction: "Head east", distance: 444, duration: 60, coordinates: geometry }],
} as unknown as Route;

// Stub fetchRoadConditions so no network is needed.
const fetchRoadConditions = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return { ...actual, fetchRoadConditions: (...a: unknown[]) => fetchRoadConditions(...a) };
});

describe("useNavIncidents — fetch-gate matrix", () => {
  beforeEach(() => {
    fetchRoadConditions.mockReset();
    fetchRoadConditions.mockResolvedValue([]);
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: false });
  });

  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: false });
  });

  const startNav = () =>
    useNavigationStore
      .getState()
      .startGroundNavigation(route, "driving", [
        geometry[0] as [number, number],
        geometry[1] as [number, number],
      ]);

  it("fetches when incidentAlerts ON, avoidIncidents OFF", async () => {
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: false });
    startNav();
    renderHook(() => useNavIncidents());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchRoadConditions).toHaveBeenCalledTimes(1);
  });

  it("fetches when incidentAlerts OFF, avoidIncidents ON (THE FIX)", async () => {
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: true });
    startNav();
    renderHook(() => useNavIncidents());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchRoadConditions).toHaveBeenCalledTimes(1);
  });

  it("fetches when both incidentAlerts and avoidIncidents are ON", async () => {
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: true });
    startNav();
    renderHook(() => useNavIncidents());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchRoadConditions).toHaveBeenCalledTimes(1);
  });

  it("does NOT fetch when both settings are OFF", async () => {
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
    startNav();
    renderHook(() => useNavIncidents());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchRoadConditions).not.toHaveBeenCalled();
  });

  it("returns ready=false and no incidents when both settings are OFF", async () => {
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
    startNav();
    const { result } = renderHook(() => useNavIncidents());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.ready).toBe(false);
    expect(result.current.incidents.length).toBe(0);
  });

  it("marks ready=true after the first fetch when only avoidIncidents is ON", async () => {
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: true });
    startNav();
    const { result } = renderHook(() => useNavIncidents());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.ready).toBe(true);
  });
});
