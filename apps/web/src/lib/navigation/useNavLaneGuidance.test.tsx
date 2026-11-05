import type { Route } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavLaneGuidanceStore } from "./laneGuidanceStore";
import { useNavLaneGuidance } from "./useNavLaneGuidance";

const fetchJunctionLookups = vi.hoisted(() => vi.fn());
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  fetchJunctionLookups: (...args: unknown[]) => fetchJunctionLookups(...args),
}));
const fixture = await import(
  "../../../../../packages/core/src/navigation/__fixtures__/junction/a57-neuss-exit20.json"
);

const a57Route = fixture.route as unknown as Route;
const holz = await import(
  "../../../../../packages/core/src/navigation/__fixtures__/junction/a44-kreuz-holz-a46.json"
);

const fixtureResponse = [
  {
    index: 0,
    approach: [
      {
        wayId: 314653469,
        highway: "motorway",
        bearing: 283,
        endDistanceMeters: 0,
        startDistanceMeters: 190,
        geometry: a57Route.geometry,
        tags: {
          lanes: 5,
          destinationLanes:
            "Krefeld;Düsseldorf Nord;Büttgen|Krefeld;Düsseldorf Nord;Büttgen|Krefeld;Düsseldorf Nord;Büttgen|Heinsberg;Aachen;Neuss-Holzheim|Heinsberg;Aachen;Neuss-Holzheim",
          destinationRefLanes: "A 57|A 57|A 57|A 46|A 46",
          turnLanes: "none|none|none|none|slight_right",
        },
      },
    ],
    ramps: [
      {
        wayId: 163585518,
        highway: "motorway_link",
        bearing: 300,
        endDistanceMeters: -170,
        startDistanceMeters: 0,
        tags: { destination: "Neuss-Zentrum" },
      },
    ],
    onMotorway: true,
  },
];

/** The fixture route as a backend that never flags motorways would send it. */
const unflaggedRoute: Route = {
  ...a57Route,
  steps: a57Route.steps.map((step) => ({ ...step, motorway: undefined })),
};

function progress(currentStepIndex: number) {
  return {
    currentStepIndex,
    distanceToNextManeuver: 400,
    distanceRemaining: 1400,
    durationRemaining: 80,
    snapped: [6.676, 51.179] as [number, number],
    alongMeters: 1000,
    deviationMeters: 0,
    segmentIndex: 0,
    etaEpochMs: 0,
    bearing: 283,
    speedMps: 30,
  };
}

function start(): void {
  useNavigationStore.setState({
    kind: "ground",
    status: "navigating",
    mode: "driving",
    connectivity: "online",
    route: a57Route,
    progress: progress(0),
  });
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

/** A northbound motorway with an exit every 500 m: each follows the last, so each counts. */
function motorwayWithExits(exits: number): { route: Route; geometry: [number, number][] } {
  const STEP_M = 500;
  const geometry = Array.from(
    { length: exits + 2 },
    (_, i) => [6.7, 51 + (i * STEP_M) / 111_320] as [number, number],
  );
  const route = {
    ...a57Route,
    distance: (exits + 1) * STEP_M,
    geometry,
    steps: [
      { instruction: "Drive", distance: STEP_M, duration: 20, coordinates: [], motorway: true },
      ...Array.from({ length: exits }, () => ({
        instruction: "Keep right",
        distance: STEP_M,
        duration: 20,
        coordinates: [],
        maneuver: { type: "fork", modifier: "right" },
      })),
    ],
  } as unknown as Route;
  return { route, geometry };
}

describe("useNavLaneGuidance", () => {
  beforeEach(() => {
    useNavLaneGuidanceStore.getState().reset();
    fetchJunctionLookups.mockReset();
  });

  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
    useNavLaneGuidanceStore.getState().reset();
  });

  it("uses the graph approach even when a different approach matches the engine count", async () => {
    const graph = {
      ...holz.lookup.approach[0],
      geometry: holz.route.geometry as [number, number][],
    };
    const farther = {
      ...graph,
      wayId: 999,
      endDistanceMeters: graph.endDistanceMeters + 100,
      tags: { lanes: 3 },
    };
    fetchJunctionLookups.mockResolvedValue([
      { ...holz.lookup, outgoingApproachWayId: graph.wayId, approach: [farther, graph] },
    ]);
    start();
    const route = holz.route as unknown as Route;
    useNavigationStore.setState({
      route: {
        ...route,
        steps: route.steps.map((step, index) =>
          index === 1
            ? {
                ...step,
                lanes: Array.from({ length: 3 }, () => ({
                  indications: ["straight"],
                  valid: false,
                })),
              }
            : step,
        ),
      },
    });
    renderHook(() => useNavLaneGuidance());
    await waitFor(() =>
      expect(useNavLaneGuidanceStore.getState().guidanceByStep.get(1)).toBeDefined(),
    );
    const model = useNavLaneGuidanceStore.getState().guidanceByStep.get(1)!;
    expect(model.lanes).toHaveLength(4);
    expect(model.preferredLanes).toEqual([]);
  });

  it("promotes a candidate exit once OpenStreetMap puts the route on the motorway there", async () => {
    fetchJunctionLookups.mockResolvedValue(fixtureResponse);
    start();
    act(() => {
      useNavigationStore.setState({ route: unflaggedRoute });
    });
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => {
      expect(useNavLaneGuidanceStore.getState().byStep.get(1)).toBeDefined();
    });
    expect(useNavLaneGuidanceStore.getState().guidanceByStep.get(1)?.source).toBe("engine");
  });

  it("keeps a candidate out when the route is not on a motorway at the split", async () => {
    fetchJunctionLookups.mockResolvedValue([{ ...fixtureResponse[0], onMotorway: false }]);
    start();
    act(() => {
      useNavigationStore.setState({ route: unflaggedRoute });
    });
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    await flush();
    expect(useNavLaneGuidanceStore.getState().byStep.size).toBe(0);
    expect(useNavLaneGuidanceStore.getState().guidanceByStep.size).toBe(0);
  });

  it("issues exactly one request per route with ≤ 40 points and stores the guidance", async () => {
    fetchJunctionLookups.mockResolvedValue(fixtureResponse);
    start();
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    const sent = fetchJunctionLookups.mock.calls[0][0] as {
      lng: number;
      lat: number;
      bearing: number;
      trace: [number, number][];
    }[];
    expect(sent).toHaveLength(1);
    expect(sent[0].trace).toHaveLength(6);
    // Oldest first: the trace runs 400 m upstream → the point → 30 m past it.
    expect(sent[0].trace[0][0]).toBeGreaterThan(sent[0].trace[4][0]);
    expect(sent[0].trace[4][0]).toBeCloseTo(6.6768, 3);
    expect(sent[0].trace[5][0]).toBeLessThan(sent[0].trace[4][0]);

    await waitFor(() => {
      const guidance = useNavLaneGuidanceStore.getState().guidanceByStep.get(1);
      expect(guidance?.lanes).toHaveLength(5);
      expect(guidance?.source).toBe("engine");
    });
  });

  it("looks up a long route's junctions in batches as the drive reaches them", async () => {
    const { route: longRoute, geometry } = motorwayWithExits(60);
    fetchJunctionLookups.mockImplementation((async (points: unknown[]) =>
      points.map((_, index) => ({ index, approach: [], ramps: [], onMotorway: true }))) as never);
    start();
    act(() => {
      useNavigationStore.setState({ route: longRoute });
    });
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    expect(fetchJunctionLookups.mock.calls[0][0]).toHaveLength(40);
    await flush();

    // Ten looked-up exits still ahead: nothing more yet.
    act(() => {
      useNavigationStore.setState({ progress: progress(30) });
    });
    await flush();
    expect(fetchJunctionLookups).toHaveBeenCalledTimes(1);

    act(() => {
      useNavigationStore.setState({ progress: progress(31) });
    });
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(2));
    const second = fetchJunctionLookups.mock.calls[1][0] as { lat: number }[];
    expect(second).toHaveLength(20);
    // Nearest first: the batch continues where the first one stopped.
    // (Within 55 m: the route's distances are great-circle, the fixture's spacing a flat guess.)
    expect(second[0].lat).toBeCloseTo(geometry[41][1], 3);
  });

  it("does not refetch or reset when only the step index advances", async () => {
    fetchJunctionLookups.mockResolvedValue(fixtureResponse);
    start();
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => expect(useNavLaneGuidanceStore.getState().guidanceByStep.size).toBe(1));
    const routeIdentity = useNavLaneGuidanceStore.getState().routeIdentity;
    act(() => {
      useNavigationStore.setState({ progress: progress(1) });
    });
    await flush();
    expect(fetchJunctionLookups).toHaveBeenCalledTimes(1);
    expect(useNavLaneGuidanceStore.getState().routeIdentity).toBe(routeIdentity);
    expect(useNavLaneGuidanceStore.getState().guidanceByStep.size).toBe(1);
  });

  it("fetches nothing when offline", async () => {
    start();
    act(() => {
      useNavigationStore.setState({ connectivity: "offline" });
    });
    renderHook(() => useNavLaneGuidance());
    await flush();
    expect(fetchJunctionLookups).not.toHaveBeenCalled();
  });

  it("looks up the exit ahead as soon as the connection returns, within the same step", async () => {
    fetchJunctionLookups.mockResolvedValue(fixtureResponse);
    start();
    act(() => {
      useNavigationStore.setState({ connectivity: "offline" });
    });
    renderHook(() => useNavLaneGuidance());
    await flush();
    expect(fetchJunctionLookups).not.toHaveBeenCalled();

    act(() => {
      useNavigationStore.setState({ connectivity: "online" });
    });
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    expect(useNavigationStore.getState().progress?.currentStepIndex).toBe(0);
  });

  it("discards a stale response from a replaced route", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    fetchJunctionLookups.mockImplementation(() =>
      resolveFirst
        ? Promise.resolve([{ index: 0, approach: [], ramps: [] }])
        : new Promise((resolve) => {
            resolveFirst = resolve;
          }),
    );
    start();
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    act(() => {
      useNavigationStore.setState({
        route: {
          ...a57Route,
          distance: 999,
          steps: a57Route.steps.map((step) => ({
            ...step,
            lanes: step.lanes?.map((lane) => ({ ...lane, valid: undefined, preferred: undefined })),
          })),
        },
      });
    });
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveFirst?.(fixtureResponse);
      await Promise.resolve();
    });
    // The stale response must not write into the new route's store state.
    expect(useNavLaneGuidanceStore.getState().guidanceByStep.get(1)?.source).toBe("engine");
  });

  it("asks again at the next step for a batch whose request failed", async () => {
    const { route: longRoute } = motorwayWithExits(20);
    let calls = 0;
    fetchJunctionLookups.mockImplementation((async (points: unknown[]) => {
      calls += 1;
      return calls === 1
        ? null
        : points.map((_, index) => ({ index, approach: [], ramps: [], onMotorway: true }));
    }) as never);
    start();
    act(() => {
      useNavigationStore.setState({ route: longRoute });
    });
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    await flush();

    act(() => {
      useNavigationStore.setState({ progress: progress(1) });
    });
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(2));
    // Every exit still ahead rides the retry.
    expect(fetchJunctionLookups.mock.calls[1][0]).toHaveLength(19);

    // Answered now: the next step asks for nothing.
    await flush();
    act(() => {
      useNavigationStore.setState({ progress: progress(2) });
    });
    await flush();
    expect(fetchJunctionLookups).toHaveBeenCalledTimes(2);
  });

  it("asks again for the junctions OpenStreetMap could not answer for, and only those", async () => {
    const { route: longRoute } = motorwayWithExits(20);
    let calls = 0;
    fetchJunctionLookups.mockImplementation((async (points: unknown[]) => {
      calls += 1;
      return points.map((_, index) =>
        calls === 1 && index === 3
          ? { index, approach: [], ramps: [], onMotorway: false, unavailable: true }
          : { index, approach: [], ramps: [], onMotorway: true },
      );
    }) as never);
    start();
    act(() => {
      useNavigationStore.setState({ route: longRoute });
    });
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    const first = fetchJunctionLookups.mock.calls[0][0] as { lat: number }[];
    await flush();

    act(() => {
      useNavigationStore.setState({ progress: progress(1) });
    });
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(2));
    const retry = fetchJunctionLookups.mock.calls[1][0] as { lat: number }[];
    expect(retry).toEqual([first[3]]);
  });

  it("asks again after a delay for a batch left unanswered, without waiting for the step to change", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      fetchJunctionLookups.mockImplementation(async () => {
        calls += 1;
        return calls === 1 ? null : fixtureResponse;
      });
      start();
      renderHook(() => useNavLaneGuidance());
      await flush();
      await flush();
      expect(fetchJunctionLookups).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_000);
      });
      expect(fetchJunctionLookups).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(fetchJunctionLookups).toHaveBeenCalledTimes(2);
      await flush();
      expect(useNavLaneGuidanceStore.getState().guidanceByStep.get(1)?.source).toBe("engine");
      expect(useNavigationStore.getState().progress?.currentStepIndex).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stretches the retry delay while OpenStreetMap stays unreachable, and drops it with the route", async () => {
    vi.useFakeTimers();
    try {
      fetchJunctionLookups.mockResolvedValue(null);
      start();
      renderHook(() => useNavLaneGuidance());
      await flush();
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(fetchJunctionLookups).toHaveBeenCalledTimes(2);
      // The second failure waits twice as long.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_000);
      });
      expect(fetchJunctionLookups).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(fetchJunctionLookups).toHaveBeenCalledTimes(3);

      act(() => {
        useNavigationStore.getState().stopNavigation();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000);
      });
      expect(fetchJunctionLookups).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks up a junction the replacement route accepts where the previous one turned it down", async () => {
    let calls = 0;
    fetchJunctionLookups.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? [{ ...fixtureResponse[0], onMotorway: false }] : fixtureResponse;
    });
    start();
    act(() => {
      useNavigationStore.setState({ route: unflaggedRoute });
    });
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    await flush();
    expect(useNavLaneGuidanceStore.getState().byStep.size).toBe(0);

    // The same exit, now accepted outright by the motorway flag.
    act(() => {
      useNavigationStore.setState({ route: a57Route });
    });
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(useNavLaneGuidanceStore.getState().guidanceByStep.get(1)?.source).toBe("engine"),
    );
  });

  it("keeps the route engine's lane evidence when OSM has no qualifying way", async () => {
    fetchJunctionLookups.mockResolvedValue([{ index: 0, approach: [], ramps: [] }]);
    start();
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalled());
    await flush();
    expect(useNavLaneGuidanceStore.getState().guidanceByStep.get(1)?.source).toBe("engine");
  });

  it("clears the store when navigation ends", async () => {
    fetchJunctionLookups.mockResolvedValue(fixtureResponse);
    start();
    renderHook(() => useNavLaneGuidance());
    expect(useNavLaneGuidanceStore.getState().byStep.size).toBe(1);
    act(() => {
      useNavigationStore.getState().stopNavigation();
    });
    expect(useNavLaneGuidanceStore.getState().routeIdentity).toBeNull();
    expect(useNavLaneGuidanceStore.getState().byStep.size).toBe(0);
  });

  it("recomputes lane advice when a replacement route shares the approach", async () => {
    fetchJunctionLookups.mockResolvedValue(fixtureResponse);
    start();
    renderHook(() => useNavLaneGuidance());
    await waitFor(() => expect(useNavLaneGuidanceStore.getState().guidanceByStep.size).toBe(1));
    const replacement = {
      ...a57Route,
      steps: a57Route.steps.map((step, i) =>
        i === 1
          ? {
              ...step,
              lanes: step.lanes?.map((lane, index) => ({
                ...lane,
                valid: index === 0,
                preferred: index === 0,
              })),
            }
          : step,
      ),
    };
    act(() => useNavigationStore.setState({ route: replacement }));
    await waitFor(() => expect(useNavLaneGuidanceStore.getState().routeIdentity).toBe(replacement));
    expect(fetchJunctionLookups).toHaveBeenCalledTimes(1);
    expect(useNavLaneGuidanceStore.getState().guidanceByStep.get(1)?.usableLanes).toEqual([0]);
  });
});
