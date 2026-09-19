import type { Route } from "@openmapx/core";
import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchJunctionLookups = vi.fn();
const searchStreetLevelImages = vi.fn();

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchJunctionLookups: (...args: unknown[]) => fetchJunctionLookups(...args),
    searchStreetLevelImages: (...args: unknown[]) => searchStreetLevelImages(...args),
  };
});

// The configured street-level providers, as the app's query hook reports them:
// two whose terms allow navigation use, and Mapillary, whose terms do not.
const providers = [
  { id: "panoramax", allowsNavigationUse: true },
  { id: "panoramax-ign", allowsNavigationUse: true },
  { id: "mapillary", allowsNavigationUse: false },
];
vi.mock("@/integration-api/components/useStreetLevelProviders", () => ({
  useStreetLevelProviders: () => ({ providers, isLoading: false }),
}));

const { useNavJunctions } = await import("./useNavJunctions");
const { useNavJunctionStore } = await import("./junctionStore");
const fixture = await import(
  "../../../../../packages/core/src/navigation/__fixtures__/junction/a57-neuss-exit20.json"
);

const a57Route = fixture.route as unknown as Route;

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

describe("useNavJunctions gantry fetch", () => {
  beforeEach(() => {
    useSettingsStore.setState({ junctionView: true, junctionPhotos: true });
    useNavJunctionStore.getState().reset();
    fetchJunctionLookups.mockReset();
    // The photo flow runs for every navigating route; tests that do not care
    // about photos must not see their providers hit.
    searchStreetLevelImages.mockReset();
    searchStreetLevelImages.mockResolvedValue([]);
  });

  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
    useNavJunctionStore.getState().reset();
  });

  it("promotes a candidate exit once OpenStreetMap puts the route on the motorway there", async () => {
    fetchJunctionLookups.mockResolvedValue(fixtureResponse);
    start();
    act(() => {
      useNavigationStore.setState({ route: unflaggedRoute });
    });
    renderHook(() => useNavJunctions());
    await waitFor(() => {
      expect(useNavJunctionStore.getState().byStep.get(1)).toBeDefined();
    });
    expect(useNavJunctionStore.getState().gantryByStep.get(1)?.source).toBe("osm");
  });

  it("keeps a candidate out when the route is not on a motorway at the split", async () => {
    fetchJunctionLookups.mockResolvedValue([{ ...fixtureResponse[0], onMotorway: false }]);
    start();
    act(() => {
      useNavigationStore.setState({ route: unflaggedRoute });
    });
    renderHook(() => useNavJunctions());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    await flush();
    expect(useNavJunctionStore.getState().decisionPoints).toEqual([]);
    expect(useNavJunctionStore.getState().gantryByStep.size).toBe(0);
  });

  it("issues exactly one request per route with ≤ 40 points and stores the gantry", async () => {
    fetchJunctionLookups.mockResolvedValue(fixtureResponse);
    start();
    renderHook(() => useNavJunctions());
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
      const gantry = useNavJunctionStore.getState().gantryByStep.get(1);
      expect(gantry?.panels).toHaveLength(3);
      expect(gantry?.source).toBe("osm");
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
    renderHook(() => useNavJunctions());
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
    renderHook(() => useNavJunctions());
    await waitFor(() => expect(useNavJunctionStore.getState().gantryByStep.size).toBe(1));
    const routeKey = useNavJunctionStore.getState().routeKey;
    act(() => {
      useNavigationStore.setState({ progress: progress(1) });
    });
    await flush();
    expect(fetchJunctionLookups).toHaveBeenCalledTimes(1);
    expect(useNavJunctionStore.getState().routeKey).toBe(routeKey);
    expect(useNavJunctionStore.getState().gantryByStep.size).toBe(1);
  });

  it("fetches nothing when offline", async () => {
    start();
    act(() => {
      useNavigationStore.setState({ connectivity: "offline" });
    });
    renderHook(() => useNavJunctions());
    await flush();
    expect(fetchJunctionLookups).not.toHaveBeenCalled();
  });

  it("fetches nothing when junctionView is off", async () => {
    useSettingsStore.setState({ junctionView: false });
    start();
    renderHook(() => useNavJunctions());
    await flush();
    expect(fetchJunctionLookups).not.toHaveBeenCalled();
  });

  it("looks up and searches the exit ahead as soon as the connection returns, within the same step", async () => {
    fetchJunctionLookups.mockResolvedValue(fixtureResponse);
    searchStreetLevelImages.mockResolvedValue([PHOTO_IMAGE]);
    start();
    act(() => {
      useNavigationStore.setState({ connectivity: "offline" });
    });
    renderHook(() => useNavJunctions());
    await flush();
    expect(fetchJunctionLookups).not.toHaveBeenCalled();

    act(() => {
      useNavigationStore.setState({ connectivity: "online" });
    });
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(searchStreetLevelImages).toHaveBeenCalled());
    expect(useNavigationStore.getState().progress?.currentStepIndex).toBe(0);
  });

  it("looks up the exit ahead as soon as junctionView is switched on, within the same step", async () => {
    fetchJunctionLookups.mockResolvedValue(fixtureResponse);
    useSettingsStore.setState({ junctionView: false });
    start();
    renderHook(() => useNavJunctions());
    await flush();
    expect(fetchJunctionLookups).not.toHaveBeenCalled();

    act(() => {
      useSettingsStore.setState({ junctionView: true });
    });
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useNavJunctionStore.getState().gantryByStep.size).toBe(1));
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
    renderHook(() => useNavJunctions());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    act(() => {
      useNavigationStore.setState({ route: { ...a57Route, distance: 999 } });
    });
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveFirst?.(fixtureResponse);
      await Promise.resolve();
    });
    // The stale response must not write into the new route's store state.
    expect(useNavJunctionStore.getState().gantryByStep.size).toBe(0);
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
    renderHook(() => useNavJunctions());
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
    renderHook(() => useNavJunctions());
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
      renderHook(() => useNavJunctions());
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
      expect(useNavJunctionStore.getState().gantryByStep.get(1)?.source).toBe("osm");
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
      renderHook(() => useNavJunctions());
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
    renderHook(() => useNavJunctions());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(1));
    await flush();
    expect(useNavJunctionStore.getState().decisionPoints).toEqual([]);

    // The same exit, now accepted outright by the motorway flag.
    act(() => {
      useNavigationStore.setState({ route: a57Route });
    });
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(useNavJunctionStore.getState().gantryByStep.get(1)?.source).toBe("osm"),
    );
  });

  it("leaves gantryByStep empty when the response has no qualifying way", async () => {
    fetchJunctionLookups.mockResolvedValue([{ index: 0, approach: [], ramps: [] }]);
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => expect(fetchJunctionLookups).toHaveBeenCalled());
    await flush();
    expect(useNavJunctionStore.getState().gantryByStep.size).toBe(0);
  });

  it("clears the store when navigation ends", async () => {
    fetchJunctionLookups.mockResolvedValue([]);
    start();
    renderHook(() => useNavJunctions());
    expect(useNavJunctionStore.getState().decisionPoints).toHaveLength(1);
    act(() => {
      useNavigationStore.getState().stopNavigation();
    });
    expect(useNavJunctionStore.getState().routeKey).toBeNull();
    expect(useNavJunctionStore.getState().decisionPoints).toEqual([]);
  });
});

const PHOTO_IMAGE = {
  id: "photo-1",
  providerId: "panoramax",
  lngLat: [6.679, 51.1786] as [number, number],
  heading: 283,
  capturedAt: "2019-09-10T06:24:40+00:00",
  isPano: false,
  fovDeg: 70,
  assets: { sd: "https://panoramax.example/sd.jpg" },
  author: "motocultrice",
  license: "CC BY-SA 4.0",
};

describe("useNavJunctions photo window", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    useSettingsStore.setState({ junctionView: true, junctionPhotos: true });
    useNavJunctionStore.getState().reset();
    fetchJunctionLookups.mockReset();
    fetchJunctionLookups.mockResolvedValue([]);
    searchStreetLevelImages.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:photo-1") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["photo"], { type: "image/jpeg" }))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    useNavigationStore.getState().stopNavigation();
    useNavJunctionStore.getState().reset();
  });

  it("searches the decision points ahead at route start, looking at the split, and marks ready", async () => {
    searchStreetLevelImages.mockResolvedValue([PHOTO_IMAGE]);
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => {
      const photo = useNavJunctionStore.getState().photoByStep.get(1);
      expect(photo?.status).toBe("ready");
      expect(photo?.image?.id).toBe("photo-1");
      expect(photo?.objectUrl).toBe("blob:photo-1");
    });
    expect(searchStreetLevelImages).toHaveBeenCalledTimes(1);
    const [providerId, query] = searchStreetLevelImages.mock.calls[0] as [
      string,
      { lookingAt?: [number, number]; lngLat: [number, number]; heading: number },
    ];
    expect(providerId).toBe("panoramax");
    expect(query.lookingAt).toEqual(query.lngLat);
    expect(query.heading).toBeCloseTo(283, 0);
  });

  it("waits for OpenStreetMap to say where the exit lanes begin before choosing a frame", async () => {
    let answer: (value: unknown) => void = () => {};
    fetchJunctionLookups.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    // 84 m and 35 m before the split; the fifth lane opens 41 m before it.
    const farther = { ...PHOTO_IMAGE, id: "at-84", lngLat: [6.678013787, 51.1787552] };
    const inLanes = { ...PHOTO_IMAGE, id: "at-35", lngLat: [6.677331862, 51.178847745] };
    searchStreetLevelImages.mockResolvedValue([farther, inLanes]);
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => expect(searchStreetLevelImages).toHaveBeenCalledTimes(1));
    await flush();
    expect(useNavJunctionStore.getState().photoByStep.get(1)?.status).toBe("loading");

    await act(async () => {
      answer([{ ...fixtureResponse[0], fullLanesFromMeters: 41 }]);
    });
    await waitFor(() => {
      expect(useNavJunctionStore.getState().photoByStep.get(1)?.image?.id).toBe("at-35");
    });
  });

  it("never searches a provider whose terms forbid use during navigation", async () => {
    searchStreetLevelImages.mockResolvedValue([]);
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => {
      expect(useNavJunctionStore.getState().photoByStep.get(1)?.status).toBe("none");
    });
    expect(searchStreetLevelImages.mock.calls.map((call) => call[0])).not.toContain("mapillary");
  });

  it("tries the second provider only when the first returns nothing, then marks none", async () => {
    searchStreetLevelImages.mockImplementation((async (providerId: string) =>
      providerId === "panoramax" ? [] : [PHOTO_IMAGE]) as never);
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => {
      expect(useNavJunctionStore.getState().photoByStep.get(1)?.status).toBe("ready");
    });
    expect(searchStreetLevelImages.mock.calls.map((call) => call[0])).toEqual([
      "panoramax",
      "panoramax-ign",
    ]);

    searchStreetLevelImages.mockReset();
    searchStreetLevelImages.mockResolvedValue([]);
    useNavJunctionStore.getState().reset();
    act(() => {
      useNavigationStore.setState({ route: { ...a57Route, distance: 1 } });
    });
    await waitFor(() => {
      expect(useNavJunctionStore.getState().photoByStep.get(1)?.status).toBe("none");
    });
  });

  it("runs nothing when offline or junctionPhotos is off", async () => {
    start();
    act(() => {
      useNavigationStore.setState({ connectivity: "offline" });
    });
    renderHook(() => useNavJunctions());
    await flush();
    expect(searchStreetLevelImages).not.toHaveBeenCalled();

    useSettingsStore.setState({ junctionPhotos: false });
    act(() => {
      useNavigationStore.setState({ connectivity: "online" });
    });
    await flush();
    expect(searchStreetLevelImages).not.toHaveBeenCalled();
  });

  it("fetches the thumbnail rather than the full frame when the provider has one", async () => {
    searchStreetLevelImages.mockResolvedValue([
      {
        ...PHOTO_IMAGE,
        assets: { ...PHOTO_IMAGE.assets, thumb: "https://panoramax.example/thumb.jpg" },
      },
    ]);
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => {
      expect(useNavJunctionStore.getState().photoByStep.get(1)?.objectUrl).toBe("blob:photo-1");
    });
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const proxied = String(fetchMock.mock.calls[0][0]);
    expect(proxied).toContain(encodeURIComponent("https://panoramax.example/thumb.jpg"));
    expect(proxied).not.toContain(encodeURIComponent("https://panoramax.example/sd.jpg"));
  });

  it("fetches a panorama's full sd frame, never its thumbnail crop", async () => {
    searchStreetLevelImages.mockResolvedValue([
      {
        ...PHOTO_IMAGE,
        isPano: true,
        fovDeg: 360,
        assets: { ...PHOTO_IMAGE.assets, thumb: "https://panoramax.example/thumb.jpg" },
      },
    ]);
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => {
      expect(useNavJunctionStore.getState().photoByStep.get(1)?.objectUrl).toBe("blob:photo-1");
    });
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const proxied = String(fetchMock.mock.calls[0][0]);
    expect(proxied).toContain(encodeURIComponent("https://panoramax.example/sd.jpg"));
    expect(proxied).not.toContain(encodeURIComponent("https://panoramax.example/thumb.jpg"));
  });

  it("falls back to the sd asset through the image proxy once, and not again per fix", async () => {
    searchStreetLevelImages.mockResolvedValue([PHOTO_IMAGE]);
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => {
      expect(useNavJunctionStore.getState().photoByStep.get(1)?.objectUrl).toBe("blob:photo-1");
    });
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const proxied = String(fetchMock.mock.calls[0][0]);
    expect(proxied).toContain("/api/image-proxy?url=");
    expect(proxied).toContain(encodeURIComponent("https://panoramax.example/sd.jpg"));
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        useNavigationStore.setState({
          progress: { ...progress(0), distanceToNextManeuver: 380 - i * 10 },
        });
      });
    }
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(searchStreetLevelImages).toHaveBeenCalledTimes(1);
  });

  it("revokes the bytes once the decision point is passed and when a new route drops the junction", async () => {
    searchStreetLevelImages.mockResolvedValue([PHOTO_IMAGE]);
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => {
      expect(useNavJunctionStore.getState().photoByStep.get(1)?.objectUrl).toBe("blob:photo-1");
    });
    act(() => {
      useNavigationStore.setState({ progress: progress(1) });
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:photo-1");
    expect(useNavJunctionStore.getState().photoByStep.get(1)?.objectUrl).toBeUndefined();

    (URL.revokeObjectURL as ReturnType<typeof vi.fn>).mockClear();
    useNavJunctionStore.getState().setPhoto(1, {
      status: "ready",
      image: PHOTO_IMAGE,
      objectUrl: "blob:photo-2",
      bytesRequested: true,
    });
    act(() => {
      useNavigationStore.setState({ route: { ...a57Route, mode: "walking" }, progress: null });
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:photo-2");
  });

  it("makes no object URL for bytes that land after the junction was passed", async () => {
    searchStreetLevelImages.mockResolvedValue([PHOTO_IMAGE]);
    let deliver: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            deliver = () => resolve(new Response(new Blob(["photo"], { type: "image/jpeg" })));
          }),
      ),
    );
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => expect(deliver).toBeDefined());
    act(() => {
      useNavigationStore.setState({ progress: progress(1) });
    });
    await act(async () => {
      deliver?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(useNavJunctionStore.getState().photoByStep.get(1)?.objectUrl).toBeUndefined();
  });

  it("writes nothing into the cleared store once the hook has unmounted", async () => {
    let deliver: (() => void) | undefined;
    searchStreetLevelImages.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = () => resolve([PHOTO_IMAGE]);
        }),
    );
    start();
    const { unmount } = renderHook(() => useNavJunctions());
    await waitFor(() => expect(deliver).toBeDefined());
    unmount();
    await act(async () => {
      deliver?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useNavJunctionStore.getState().photoByStep.size).toBe(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("keeps the gantry and photo of a junction the replacement route shares", async () => {
    fetchJunctionLookups.mockResolvedValue([{ ...fixtureResponse[0], fullLanesFromMeters: 60 }]);
    searchStreetLevelImages.mockResolvedValue([PHOTO_IMAGE]);
    start();
    renderHook(() => useNavJunctions());
    await waitFor(() => {
      const state = useNavJunctionStore.getState();
      expect(state.gantryByStep.get(1)).toBeDefined();
      expect(state.photoByStep.get(1)?.objectUrl).toBe("blob:photo-1");
    });

    // An accepted faster route: the same exit, one step later in the list.
    const faster: Route = {
      ...a57Route,
      steps: [
        { instruction: "Continue", distance: 0, duration: 0, coordinates: [], motorway: true },
        ...a57Route.steps,
      ],
    };
    act(() => {
      useNavigationStore.setState({ route: faster, progress: null });
    });
    const state = useNavJunctionStore.getState();
    expect(state.decisionPoints.map((point) => point.stepIndex)).toEqual([2]);
    expect(state.gantryByStep.get(2)?.source).toBe("osm");
    expect(state.fullLanesByStep.get(2)).toBe(60);
    expect(state.photoByStep.get(2)?.objectUrl).toBe("blob:photo-1");
    await flush();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(fetchJunctionLookups).toHaveBeenCalledTimes(1);
    expect(searchStreetLevelImages).toHaveBeenCalledTimes(1);
  });
});
