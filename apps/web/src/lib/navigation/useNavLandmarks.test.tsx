import type { NavigationLandmarkResult, Route } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OSM_ATTRIBUTION } from "@/lib/map";
import { nth } from "@/test";

const fetchNavigationLandmarks = vi.hoisted(() => vi.fn());
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  fetchNavigationLandmarks: (...args: unknown[]) => fetchNavigationLandmarks(...args),
}));
const attributions = vi.hoisted(() => vi.fn());
vi.mock("@/integration-api/overlay/useMapAttributions", () => ({
  useMapAttributions: (id: string, credits: unknown[]) => attributions(id, credits),
}));

const { useNavLandmarks } = await import("./useNavLandmarks");

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((52.5 * Math.PI) / 180);
const at = (east: number, north: number): [number, number] => [
  13.4 + east / M_PER_DEG_LON,
  52.5 + north / M_PER_DEG_LAT,
];

/** A northbound street with a right turn every 400 m; turn `i` is step `i + 1`. */
function streetWithTurns(turns: number, tag = "a"): Route {
  const end = 400 * (turns + 1);
  return {
    distance: end,
    duration: end / 10,
    geometry: [at(0, 0), at(0, end)],
    summary: tag,
    steps: [
      {
        instruction: "Drive",
        distance: 400,
        duration: 40,
        coordinates: [at(0, 0)],
        maneuver: { type: "depart" },
      },
      ...Array.from({ length: turns }, (_, i) => ({
        instruction: "Turn right",
        distance: 400,
        duration: 40,
        coordinates: [at(0, 400 * (i + 1))],
        bearingBefore: 0,
        bearingAfter: 90,
        maneuver: { type: "turn", modifier: "right" },
      })),
      {
        instruction: "Arrive",
        distance: 0,
        duration: 0,
        coordinates: [at(0, end)],
        maneuver: { type: "arrive" },
      },
    ],
  } as unknown as Route;
}

function progress(currentStepIndex: number) {
  return {
    currentStepIndex,
    distanceToNextManeuver: 200,
    distanceRemaining: 1000,
    durationRemaining: 100,
    snapped: at(0, 0),
    alongMeters: 0,
    deviationMeters: 0,
    segmentIndex: 0,
    etaEpochMs: 0,
    bearing: 0,
    speedMps: 10,
  };
}

function start(route: Route, mode: "driving" | "walking" = "driving"): void {
  useNavigationStore.setState({
    kind: "ground",
    status: "navigating",
    mode,
    connectivity: "online",
    route,
    progress: progress(0),
    landmarkReferences: null,
  });
}

/** An answer with a fuel station on the right corner of the first point only. */
function fuelAtFirst(points: { lat: number; lon: number }[]): NavigationLandmarkResult[] {
  return points.map((point, i) => {
    if (i > 0) return { candidates: [] };
    const lon = point.lon + 15 / M_PER_DEG_LON;
    const lat = point.lat - 10 / M_PER_DEG_LAT;
    return { candidates: [{ category: "fuel", brand: "Aral", lat, lon }] };
  });
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("useNavLandmarks", () => {
  beforeEach(() => {
    fetchNavigationLandmarks.mockReset();
    attributions.mockReset();
  });
  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
  });

  it("selects landmarks from the answer and credits OpenStreetMap", async () => {
    const route = streetWithTurns(3);
    start(route);
    fetchNavigationLandmarks.mockImplementation(async (points) => fuelAtFirst(points));
    renderHook(() => useNavLandmarks());
    await flush();
    expect(fetchNavigationLandmarks).toHaveBeenCalledTimes(1);
    const points = nth(fetchNavigationLandmarks.mock.calls, 0)[0] as { lat: number; lon: number }[];
    expect(points).toHaveLength(3);
    expect(nth(points, 0).lat).toBeCloseTo(52.5 + 400 / M_PER_DEG_LAT, 6);
    expect(useNavigationStore.getState().landmarkReferences).toEqual({
      route,
      byStep: { 1: { stepIndex: 1, category: "fuel", brand: "Aral" } },
    });
    expect(attributions).toHaveBeenLastCalledWith("nav-landmark-references", [OSM_ATTRIBUTION]);
  });

  it("credits nobody without a landmark reference", async () => {
    start(streetWithTurns(3));
    fetchNavigationLandmarks.mockResolvedValue([
      { candidates: [] },
      { candidates: [] },
      { candidates: [] },
    ]);
    renderHook(() => useNavLandmarks());
    await flush();
    expect(attributions).toHaveBeenLastCalledWith("nav-landmark-references", []);
  });

  it("ignores a landmark answer keyed to an old route", async () => {
    let answer: (value: NavigationLandmarkResult[]) => void = () => {};
    let requested: { lat: number; lon: number }[] = [];
    fetchNavigationLandmarks.mockImplementationOnce((points) => {
      requested = points;
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    fetchNavigationLandmarks.mockResolvedValue(null);
    start(streetWithTurns(3, "old"));
    renderHook(() => useNavLandmarks());
    await flush();
    act(() => useNavigationStore.setState({ route: streetWithTurns(3, "new") }));
    await act(async () => answer(fuelAtFirst(requested)));
    await flush();
    expect(useNavigationStore.getState().landmarkReferences).toBeNull();
  });

  it("requests the next batch when fewer than 10 remain", async () => {
    start(streetWithTurns(60));
    fetchNavigationLandmarks.mockImplementation(async (points: unknown[]) =>
      points.map(() => ({ candidates: [] })),
    );
    renderHook(() => useNavLandmarks());
    await flush();
    expect(fetchNavigationLandmarks).toHaveBeenCalledTimes(1);
    expect(nth(fetchNavigationLandmarks.mock.calls, 0)[0]).toHaveLength(40);
    // Steps 1–40 were requested. At step 30, eleven requested ones remain ahead.
    act(() => useNavigationStore.setState({ progress: progress(30) }));
    await flush();
    expect(fetchNavigationLandmarks).toHaveBeenCalledTimes(1);
    // At step 31, only nine remain: ask for the rest.
    act(() => useNavigationStore.setState({ progress: progress(31) }));
    await flush();
    expect(fetchNavigationLandmarks).toHaveBeenCalledTimes(2);
    expect(nth(fetchNavigationLandmarks.mock.calls, 1)[0]).toHaveLength(20);
  });

  it("a failed answer leaves no references", async () => {
    start(streetWithTurns(3));
    fetchNavigationLandmarks.mockResolvedValue(null);
    renderHook(() => useNavLandmarks());
    await flush();
    expect(useNavigationStore.getState().landmarkReferences).toBeNull();
    act(() => useNavigationStore.setState({ progress: progress(1) }));
    await flush();
    expect(fetchNavigationLandmarks).toHaveBeenCalledTimes(1);
  });

  it("does nothing on foot or offline", async () => {
    start(streetWithTurns(3), "walking");
    const { unmount } = renderHook(() => useNavLandmarks());
    await flush();
    unmount();
    start(streetWithTurns(3));
    useNavigationStore.setState({ connectivity: "offline" });
    renderHook(() => useNavLandmarks());
    await flush();
    expect(fetchNavigationLandmarks).not.toHaveBeenCalled();
  });
});
