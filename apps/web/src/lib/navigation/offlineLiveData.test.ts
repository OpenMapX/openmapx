// @vitest-environment jsdom

import {
  cumulativeDistances,
  type NavProgress,
  type Route,
  type RouteMatchWindow,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavAlerts } from "./useNavAlerts";
import { useNavIncidents } from "./useNavIncidents";
import { useNavTrafficSignals } from "./useNavTrafficSignals";

const fetchRoadConditionsWithStatus = vi.fn();
const fetchRouteMatchWindow = vi.fn();
const fetchRoadAlerts = vi.fn();

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    fetchRoadConditionsWithStatus: (...args: unknown[]) => fetchRoadConditionsWithStatus(...args),
    fetchRouteMatchWindow: (...args: unknown[]) => fetchRouteMatchWindow(...args),
    fetchRoadAlerts: (...args: unknown[]) => fetchRoadAlerts(...args),
    useCountryFromCoordinates: () => ({ data: null }),
  };
});

const geometry: [number, number][] = [
  [13, 52],
  [13.01, 52],
];
const route: Route = {
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
};

function startNavigation() {
  useNavigationStore.getState().startGroundNavigation(route, "driving", geometry);
}

describe("offline live-data gating", () => {
  beforeEach(() => {
    fetchRoadConditionsWithStatus.mockReset().mockResolvedValue({ ok: true, events: [] });
    fetchRouteMatchWindow.mockReset().mockResolvedValue({
      signals: [],
      speedLimitsByPoint: [50, null],
      countriesByPoint: ["DE", "DE"],
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({
      incidentAlerts: true,
      avoidIncidents: false,
      speedCameraAlerts: false,
    });
  });

  it("does not schedule incidents, route-match, or alert requests offline", async () => {
    renderHook(() => {
      const resource = useNavIncidents();
      useNavTrafficSignals();
      useNavAlerts(resource);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchRoadConditionsWithStatus).not.toHaveBeenCalled();
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

  it("publishes the route's countries and keeps them offline", async () => {
    useNavigationStore.getState().setConnectivity("online");
    renderHook(() => useNavTrafficSignals());
    await waitFor(() =>
      expect(useNavigationStore.getState().routeCountries).toEqual([
        { fromMeters: 0, countryCode: "DE" },
      ]),
    );

    act(() => useNavigationStore.getState().setConnectivity("offline"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(useNavigationStore.getState().routeCountries).toEqual([
      { fromMeters: 0, countryCode: "DE" },
    ]);
  });

  it("allows the live hooks to fetch again after connectivity returns", async () => {
    const { rerender } = renderHook(() => {
      const resource = useNavIncidents();
      useNavTrafficSignals();
      useNavAlerts(resource);
    });
    expect(fetchRoadConditionsWithStatus).not.toHaveBeenCalled();

    act(() => useNavigationStore.getState().setConnectivity("online"));
    rerender();
    await waitFor(() => {
      expect(fetchRoadConditionsWithStatus).toHaveBeenCalled();
      expect(fetchRouteMatchWindow).toHaveBeenCalled();
      expect(fetchRoadAlerts).toHaveBeenCalled();
    });
  });

  it("fetches distance-bounded windows and publishes later limits at their route indices", async () => {
    const long: [number, number][] = [
      [0, 0],
      [0, 0.3],
      [0, 0.6],
      [0, 0.9],
      [0, 1.2],
      [0, 1.5],
    ];
    const cum = cumulativeDistances(long);
    fetchRouteMatchWindow.mockImplementation(async (...args: unknown[]) => {
      const trace = args[0] as [number, number][];
      return {
        signals: [],
        speedLimitsByPoint: trace.map(() => (trace[0][1] === 0 ? 30 : 70)),
        countriesByPoint: trace.map(() => "DE"),
      };
    });
    useNavigationStore
      .getState()
      .startGroundNavigation({ ...route, geometry: long }, "driving", [long[0], long[5]]);
    useNavigationStore.getState().setConnectivity("online");
    renderHook(() => useNavTrafficSignals());

    await waitFor(() =>
      expect(useNavigationStore.getState().liveSpeedLimits).toEqual([30, 30, 30, null, null, null]),
    );

    act(() => useNavigationStore.setState({ progress: { alongMeters: cum[2] } as NavProgress }));
    await waitFor(() =>
      expect(useNavigationStore.getState().liveSpeedLimits).toEqual([30, 30, 70, 70, 70, null]),
    );

    act(() => useNavigationStore.setState({ progress: { alongMeters: cum[4] } as NavProgress }));
    await waitFor(() =>
      expect(useNavigationStore.getState().liveSpeedLimits).toEqual([30, 30, 70, 70, 70, 70]),
    );
  });

  it.each(["offline", "reroute", "unmount"])(
    "cancels obsolete window requests on %s and ignores late results",
    async (change) => {
      const resolveRequests: ((result: RouteMatchWindow) => void)[] = [];
      fetchRouteMatchWindow.mockImplementation(
        () =>
          new Promise<RouteMatchWindow>((resolve) => {
            resolveRequests.push(resolve);
          }),
      );
      useNavigationStore.getState().setConnectivity("online");
      const { unmount } = renderHook(() => useNavTrafficSignals());
      const signal = (
        fetchRouteMatchWindow.mock.calls[0][2] as { signal?: AbortSignal } | undefined
      )?.signal;
      expect(signal?.aborted).toBe(false);

      act(() => {
        if (change === "offline") useNavigationStore.getState().setConnectivity("offline");
        else if (change === "reroute") useNavigationStore.getState().applyReroute({ ...route });
        else unmount();
      });
      expect(signal?.aborted).toBe(true);
      await act(async () =>
        resolveRequests[0]({
          signals: [geometry[0]],
          speedLimitsByPoint: [90, 90],
          countriesByPoint: ["DE", "DE"],
        }),
      );
      expect(useNavigationStore.getState().liveSpeedLimits).toBeNull();
      if (change === "reroute") {
        const replacementSignal = (
          fetchRouteMatchWindow.mock.calls[1][2] as { signal: AbortSignal }
        ).signal;
        expect(replacementSignal.aborted).toBe(false);
        await act(async () =>
          resolveRequests[1]({
            signals: [],
            speedLimitsByPoint: [70, 70],
            countriesByPoint: ["DE", "DE"],
          }),
        );
        expect(useNavigationStore.getState().liveSpeedLimits).toEqual([70, 70]);
      }
    },
  );

  it("recovers a later window through the real API client without skipping it", async () => {
    const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
    actual.configureApiClient({ baseUrl: "https://openmapx.example" });
    fetchRouteMatchWindow.mockImplementation((...args: unknown[]) =>
      actual.fetchRouteMatchWindow(
        args[0] as [number, number][],
        "driving",
        args[2] as { signal?: AbortSignal },
      ),
    );
    const long: [number, number][] = [
      [0, 0],
      [0, 0.3],
      [0, 0.6],
      [0, 0.9],
      [0, 1.2],
      [0, 1.5],
    ];
    const cum = cumulativeDistances(long);
    const requested: { lat: number; lng: number }[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((...args: unknown[]) => {
        const init = args[1] as RequestInit;
        const trace = JSON.parse(String(init.body)).trace as { lat: number; lng: number }[];
        requested.push(trace);
        if (requested.length === 2) return Promise.resolve(new Response("", { status: 503 }));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              mode: "driving",
              provider: "routing-valhalla",
              geometry: [],
              edges: [{ speedLimit: trace[0].lat === 0 ? 50 : 70, endNodeCountryCode: "DE" }],
              points: trace.map(({ lat, lng }) => ({ lat, lng, type: "matched", edgeIndex: 0 })),
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
      }),
    );
    useNavigationStore
      .getState()
      .startGroundNavigation({ ...route, geometry: long }, "driving", [long[0], long[5]]);
    useNavigationStore.getState().setConnectivity("online");
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useNavTrafficSignals());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(useNavigationStore.getState().liveSpeedLimits).toEqual([50, 50, 50, null, null, null]);
    act(() => useNavigationStore.setState({ progress: { alongMeters: cum[2] } as NavProgress }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(requested).toHaveLength(2);
    expect(useNavigationStore.getState().liveSpeedLimits).toEqual([50, 50, 50, null, null, null]);
    // Further GPS progress during backoff must not skip this window or start another request.
    act(() => useNavigationStore.setState({ progress: { alongMeters: cum[3] } as NavProgress }));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(requested).toHaveLength(3);
    expect(requested[2]).toEqual(requested[1]);
    expect(useNavigationStore.getState().liveSpeedLimits).toEqual([50, 50, 70, 70, 70, null]);
    unmount();
  });
});
