// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavIncidents } from "./useNavIncidents";

// A straight ~444 m route at the equator.
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

const fetchRoadConditionsWithStatus = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    fetchRoadConditionsWithStatus: (...a: unknown[]) => fetchRoadConditionsWithStatus(...a),
  };
});

function startNav(r: Route = route) {
  useNavigationStore
    .getState()
    .startGroundNavigation(r, "driving", [
      geometry[0] as [number, number],
      geometry[1] as [number, number],
    ]);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useNavIncidents — fetch-gate matrix", () => {
  beforeEach(() => {
    fetchRoadConditionsWithStatus.mockReset();
    fetchRoadConditionsWithStatus.mockResolvedValue({ ok: true, events: [] });
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: false });
  });

  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: false });
  });

  it("fetches when incidentAlerts ON, avoidIncidents OFF", async () => {
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: false });
    startNav();
    renderHook(() => useNavIncidents());
    await flush();
    expect(fetchRoadConditionsWithStatus).toHaveBeenCalledTimes(1);
  });

  it("fetches when incidentAlerts OFF, avoidIncidents ON", async () => {
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: true });
    startNav();
    renderHook(() => useNavIncidents());
    await flush();
    expect(fetchRoadConditionsWithStatus).toHaveBeenCalledTimes(1);
  });

  it("does NOT fetch when both settings are OFF", async () => {
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
    startNav();
    renderHook(() => useNavIncidents());
    await flush();
    expect(fetchRoadConditionsWithStatus).not.toHaveBeenCalled();
  });

  it("returns status=disabled and no incidents when both settings are OFF", async () => {
    useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false });
    startNav();
    const { result } = renderHook(() => useNavIncidents());
    await flush();
    expect(result.current.status).toBe("disabled");
    expect(result.current.incidents.length).toBe(0);
  });

  it("is inactive without a live ground-navigation route (idle)", async () => {
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: true });
    const { result } = renderHook(() => useNavIncidents());
    await flush();
    expect(fetchRoadConditionsWithStatus).not.toHaveBeenCalled();
    expect(result.current.status).toBe("disabled");
  });

  it("is inactive once navigation has arrived", async () => {
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: true });
    startNav();
    const { result, rerender } = renderHook(() => useNavIncidents());
    await flush();
    fetchRoadConditionsWithStatus.mockClear();
    act(() => useNavigationStore.getState().completeArrival());
    rerender();
    await flush();
    expect(fetchRoadConditionsWithStatus).not.toHaveBeenCalled();
    expect(result.current.status).toBe("disabled");
  });
});

describe("useNavIncidents — truthful status", () => {
  beforeEach(() => {
    fetchRoadConditionsWithStatus.mockReset();
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: false });
  });

  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: false });
  });

  it("reports fresh with successfulRevision=1 after the first successful fetch", async () => {
    fetchRoadConditionsWithStatus.mockResolvedValue({ ok: true, events: [] });
    startNav();
    const { result } = renderHook(() => useNavIncidents());
    await flush();
    expect(result.current.status).toBe("fresh");
    expect(result.current.successfulRevision).toBe(1);
    expect(result.current.routeIdentity).toBe(route);
  });

  it("never reports fresh when the only response so far failed", async () => {
    fetchRoadConditionsWithStatus.mockResolvedValue({ ok: false, events: [] });
    startNav();
    const { result } = renderHook(() => useNavIncidents());
    await flush();
    expect(result.current.status).not.toBe("fresh");
    expect(result.current.successfulRevision).toBe(0);
    expect(result.current.incidents).toEqual([]);
  });

  it("reports offline and never fresh while connectivity is offline", async () => {
    fetchRoadConditionsWithStatus.mockResolvedValue({ ok: true, events: [] });
    startNav();
    useNavigationStore.getState().setConnectivity("offline");
    const { result } = renderHook(() => useNavIncidents());
    await flush();
    expect(result.current.status).toBe("offline");
    expect(fetchRoadConditionsWithStatus).not.toHaveBeenCalled();
  });
});
