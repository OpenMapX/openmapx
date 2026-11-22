import type { NavProgress, Route } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import type { LaneHighlightAnswer } from "../web/derive/lane-highlight";
import type { LaneHighlightQuery, MapDetailsWorkerClient } from "../web/worker-client";

let fake: FakeMap;
const mapRef: { current: unknown } = { current: null };
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/overlay/useRenderedMapAttributions", () => ({
  useRenderedMapAttributions: () => {},
}));

import { LaneHighlight } from "../lane-highlight";

const LAYER = "nav-lane-highlight";
const M = 1 / 111_195;
const geometry: [number, number][] = [
  [13.4, 52.5],
  [13.4, 52.5 + 100 * M],
  [13.4, 52.5 + 200 * M],
  [13.4, 52.5 + 300 * M],
];
function makeRoute(distance = 300): Route {
  return {
    distance,
    duration: 30,
    legs: [],
    mode: "driving",
    geometry,
    steps: [
      { instruction: "Head north", distance: 200, duration: 20, coordinates: geometry.slice(0, 3) },
      {
        instruction: "Turn right",
        distance: 100,
        duration: 10,
        coordinates: geometry.slice(2),
        maneuver: { type: "turn", modifier: "right" },
        lanes: [
          { indications: ["left"], valid: false },
          { indications: ["right"], valid: true, preferred: true, active: "right" },
        ],
      },
      { instruction: "Arrive", distance: 0, duration: 0, coordinates: [] },
    ],
  } as unknown as Route;
}
const POLYGON: [number, number][] = [
  [13.4, 52.5 + 120 * M],
  [13.40003, 52.5 + 120 * M],
  [13.40003, 52.5 + 190 * M],
  [13.4, 52.5 + 120 * M],
];

function progress(distanceToNextManeuver: number): NavProgress {
  return {
    snapped: geometry[0],
    alongMeters: 200 - distanceToNextManeuver,
    deviationMeters: 0,
    segmentIndex: 0,
    etaEpochMs: 0,
    bearing: 0,
    speedMps: 10,
    currentStepIndex: 0,
    distanceToNextManeuver,
    distanceRemaining: 100 + distanceToNextManeuver,
    durationRemaining: 20,
  } as NavProgress;
}

const answers: Array<(answer: LaneHighlightAnswer | null) => void> = [];
const queries: LaneHighlightQuery[] = [];
const client = {
  paint: vi.fn(async () => null),
  objects: vi.fn(async () => []),
  laneHighlight: vi.fn(
    (query: LaneHighlightQuery, signal?: AbortSignal) =>
      new Promise<LaneHighlightAnswer | null>((resolve) => {
        queries.push(query);
        answers.push(resolve);
        signal?.addEventListener("abort", () => resolve(null));
      }),
  ),
  dispose: vi.fn(),
} as unknown as MapDetailsWorkerClient;

function mount(props: Partial<Parameters<typeof LaneHighlight>[0]> = {}) {
  return render(
    <LaneHighlight
      client={client}
      streetTemplate="https://maps.example/street/{z}/{x}/{y}.pbf"
      zoom={17}
      satellite={false}
      mode="navigation"
      contributors={[]}
      {...props}
    />,
  );
}

const flush = () => act(async () => await Promise.resolve());
const drawn = () =>
  (fake.state.sources.get(LAYER)?.data as { features?: unknown[] } | undefined)?.features?.length ??
  0;

beforeEach(() => {
  fake = createFakeMap({ styleLoaded: true, baseLayers: [{ id: "labels", type: "symbol" }] });
  mapRef.current = fake.map;
  answers.length = 0;
  queries.length = 0;
  (client.laneHighlight as ReturnType<typeof vi.fn>).mockClear();
  useNavigationStore.getState().stopNavigation();
  useNavigationStore
    .getState()
    .startGroundNavigation(makeRoute(), "driving", [
      geometry[0] as [number, number],
      geometry[3] as [number, number],
    ]);
  useNavigationStore.setState({ progress: progress(50), approachWayIds: { 1: 1234 } });
  useNavigationSceneStore.getState().setActive(true);
});
afterEach(() => {
  useNavigationSceneStore.getState().setActive(false);
  useNavigationStore.getState().stopNavigation();
});

describe("LaneHighlight", () => {
  it("draws polygons inside the approach window at zoom ≥ 16", async () => {
    mount();
    expect(queries[0]).toMatchObject({ wayId: 1234, recommended: [1] });
    await act(async () =>
      answers[0]?.({ polygons: [POLYGON], startBeforeManeuver: 80, endBeforeManeuver: 5 }),
    );
    expect(drawn()).toBe(1);
    expect(fake.state.layers.get(LAYER)).toMatchObject({ type: "fill" });
    expect(fake.state.paint.get(LAYER)?.["fill-opacity"]).toBe(0.55);
    const span = useNavigationSceneStore.getState().highlightSpan;
    expect(span?.fromAlong).toBeCloseTo(120, 0);
    expect(span?.toAlong).toBeCloseTo(195, 0);
  });

  it.each([
    ["below zoom 16", { zoom: 15.5 }],
    ["on satellite", { satellite: true }],
    ["without street detail", { streetTemplate: null }],
  ])("nothing %s", async (_, props) => {
    mount(props);
    await flush();
    expect(queries).toHaveLength(0);
    expect(drawn()).toBe(0);
  });

  it("nothing outside the approach window", async () => {
    useNavigationStore.setState({ progress: progress(5000) });
    mount();
    await flush();
    expect(queries).toHaveLength(0);
  });

  it("drops a worker answer for a superseded route", async () => {
    mount();
    act(() => useNavigationStore.getState().applyReroute(makeRoute(301)));
    await act(async () =>
      answers[0]?.({ polygons: [POLYGON], startBeforeManeuver: 80, endBeforeManeuver: 5 }),
    );
    expect(drawn()).toBe(0);
    expect(useNavigationSceneStore.getState().highlightSpan).toBeNull();
  });

  it("clears the highlight and the route's transparent span when 3D turns off", async () => {
    mount();
    await act(async () =>
      answers[0]?.({ polygons: [POLYGON], startBeforeManeuver: 80, endBeforeManeuver: 5 }),
    );
    expect(drawn()).toBe(1);
    act(() => useNavigationSceneStore.getState().setActive(false));
    await flush();
    expect(drawn()).toBe(0);
    expect(useNavigationSceneStore.getState().highlightSpan).toBeNull();
  });

  it("requests once per manoeuvre, not per frame", async () => {
    mount();
    for (let d = 49; d > 30; d--) {
      act(() => useNavigationStore.setState({ progress: progress(d) }));
    }
    await flush();
    expect(queries).toHaveLength(1);
  });

  it("a reroute mid-approach clears and re-requests for the new route", async () => {
    mount();
    await act(async () =>
      answers[0]?.({ polygons: [POLYGON], startBeforeManeuver: 80, endBeforeManeuver: 5 }),
    );
    expect(drawn()).toBe(1);
    act(() => {
      useNavigationStore.getState().applyReroute(makeRoute(302));
      useNavigationStore.setState({ progress: progress(50), approachWayIds: { 1: 1234 } });
    });
    await flush();
    expect(drawn()).toBe(0);
    expect(queries).toHaveLength(2);
  });
});
