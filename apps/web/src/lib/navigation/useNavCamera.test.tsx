// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import type { LngLat, NavProgress } from "@openmapx/core";
import {
  approachTargetZoom,
  cumulativeDistances,
  junctionFitZoom,
  lookAheadBearing,
  lookAheadMeters,
  maneuverArrowLine,
  maneuverArrowSpans,
  maneuverStartMeters,
  positionAt,
  speedZoom,
  stepDeadReckon,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/map/MapContext", () => {
  const value = {
    mapRef: { current: null as unknown },
    mapReady: false,
    styleVersion: 0,
  };
  return { __test: value, useMap: () => value, useMapOptional: () => value };
});

vi.mock("maplibre-gl", () => {
  const markers: unknown[] = [];
  class FakeMarker {
    element: HTMLElement;
    options: Record<string, unknown>;
    map: unknown = null;
    lngLat: [number, number] = [0, 0];
    rotation = 0;
    addToCount = 0;
    removeCount = 0;
    setLngLatCount = 0;
    setRotationCount = 0;
    ops: string[] = [];

    constructor(options: { element: HTMLElement }) {
      this.element = options.element;
      this.options = options;
      markers.push(this);
    }

    setLngLat(lngLat: [number, number]) {
      this.lngLat = lngLat;
      this.setLngLatCount += 1;
      this.ops.push("setLngLat");
      return this;
    }

    setRotation(rotation: number) {
      this.rotation = rotation;
      this.setRotationCount += 1;
      this.ops.push("setRotation");
      return this;
    }

    addTo(map: unknown) {
      this.map = map;
      this.addToCount += 1;
      this.ops.push("addTo");
      return this;
    }

    remove() {
      this.map = null;
      this.removeCount += 1;
      this.ops.push("remove");
      return this;
    }

    getElement() {
      return this.element;
    }
  }
  return { __test: { markers }, Marker: FakeMarker };
});

import * as maplibre from "maplibre-gl";
import * as mapContext from "@/integration-api/map/MapContext";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import {
  type CameraViewport,
  getCameraFrameTarget,
  type ResolvedPadding,
} from "@/lib/cameraPadding";
import { publishMapObstruction } from "@/lib/mapObstructions";
import { createFakeMap, type FakeMap, nth } from "@/test";
import { CAMERA_ZOOM_EPSILON } from "./navCameraScheduler";
import { useNavCamera } from "./useNavCamera";

interface MarkerRecord {
  options: Record<string, unknown>;
  map: unknown;
  lngLat: [number, number];
  rotation: number;
  addToCount: number;
  removeCount: number;
  setLngLatCount: number;
  setRotationCount: number;
  ops: string[];
  getElement(): HTMLElement;
}

const markerTest = (maplibre as unknown as { __test: { markers: MarkerRecord[] } }).__test;
const mapContextTest = (
  mapContext as unknown as {
    __test: { mapRef: { current: unknown }; mapReady: boolean; styleVersion: number };
  }
).__test;

/**
 * A single-slot animation-frame queue driven by an explicit monotonic clock, so
 * every assertion below is about real scheduling decisions rather than timer
 * luck. `flush` advances the clock first and then runs whatever callback is
 * outstanding, the way a browser does, and fails loudly if the hook ever leaves
 * more than one frame pending.
 */
function createFrameHarness(startMs: number) {
  let clock = startMs;
  let handle = 0;
  const queue = new Map<number, FrameRequestCallback>();
  let requests = 0;
  let cancels = 0;

  const request = (cb: FrameRequestCallback) => {
    requests += 1;
    handle += 1;
    queue.set(handle, cb);
    if (queue.size > 1) throw new Error(`overlapping animation frames: ${queue.size}`);
    return handle;
  };
  const cancel = (h: number) => {
    if (queue.delete(h)) cancels += 1;
  };

  return {
    request,
    cancel,
    now: () => clock,
    pending: () => queue.size,
    requests: () => requests,
    cancels: () => cancels,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Advance `msPerFrame` and run the pending callback, `count` times over. */
    flush(count: number, msPerFrame = 16) {
      for (let i = 0; i < count; i += 1) {
        clock += msPerFrame;
        const entries = [...queue.entries()];
        queue.clear();
        for (const [, cb] of entries) cb(clock);
        if (queue.size > 1) throw new Error(`overlapping animation frames: ${queue.size}`);
      }
    },
  };
}

type FrameHarness = ReturnType<typeof createFrameHarness>;

// A route that runs east, bends north-east at 668 m, then east again, so a
// moving replay crosses a vertex and exercises the bearing filter.
const geometry: LngLat[] = [
  [0, 0],
  [0.006, 0],
  [0.012, 0.003],
  [0.02, 0.003],
];
const cum = cumulativeDistances(geometry);
const routeLengthMeters = nth(cum, -1);
const route = {
  distance: routeLengthMeters,
  duration: 200,
  geometry,
  legs: [],
  mode: "driving",
  steps: [
    {
      instruction: "Head east",
      distance: nth(cum, 1),
      duration: 60,
      coordinates: geometry.slice(0, 2),
      maneuver: { type: "depart" },
    },
    {
      instruction: "Keep left",
      distance: routeLengthMeters - nth(cum, 1),
      duration: 140,
      coordinates: geometry.slice(1),
      maneuver: { type: "keep", modifier: "left" },
    },
    {
      instruction: "Arrive",
      distance: 0,
      duration: 0,
      coordinates: [],
      maneuver: { type: "arrive" },
    },
  ],
} as unknown as Route;

const CLOCK_START = 1000;
const FRAME_MS = 16;
const SPEED_MPS = 20;
const START_ALONG = 600;
// One fix per replay round; a round is a whole second of travel at SPEED_MPS.
const ROUND_FRAMES = 60;
const FIX_STEP_METERS = (SPEED_MPS * ROUND_FRAMES * FRAME_MS) / 1000;
const ENTER_ZOOM = 16;
const SETTLE_UNTIL = CLOCK_START + 370;

function makeProgress(
  alongMeters: number,
  speedMps: number,
  distanceToNextManeuver = 100,
): NavProgress {
  const { point, bearing } = positionAt(geometry, cum, alongMeters);
  return {
    snapped: point,
    alongMeters,
    deviationMeters: 0,
    segmentIndex: 0,
    etaEpochMs: 0,
    bearing,
    speedMps,
    currentStepIndex: 0,
    distanceToNextManeuver,
    distanceRemaining: routeLengthMeters - alongMeters,
    durationRemaining: 100,
  };
}

/** The hook's own angle ease, restated so the oracle is independent of it. */
function easeAngle(current: number, target: number, alpha: number): number {
  const diff = ((target - current + 540) % 360) - 180;
  return (current + diff * alpha + 360) % 360;
}

function targetZoomForSpeed(speedMps: number): number {
  return Math.max(14, Math.min(17, 17 - (Math.max(speedMps, 0) / 33) * 3));
}

/** The "Keep left" maneuver's way in and way out, as the approach camera frames them. */
const approachLegs = (): LngLat[] => {
  const legs = maneuverArrowLine(
    geometry,
    cum,
    maneuverStartMeters(route, 1),
    maneuverArrowSpans("driving"),
  );
  if (!legs) throw new Error("fixture route carries no arrow");
  return legs;
};

interface PuckFrame {
  lng: number;
  lat: number;
  rotation: number;
}
interface CameraFrame {
  frame: number;
  center: [number, number];
  bearing: number;
  zoom: number;
}
interface Replay {
  rounds: number;
  roundFrames: number;
  msPerFrame: number;
}

/**
 * The pose the puck and the follow camera are expected to show on every frame
 * of the moving replay, integrated straight from the shared navigation
 * primitives and the hook's documented filter constants. Recorded against the
 * pre-change implementation, it is the equivalence oracle the scheduling work
 * must not disturb: the puck sequence is compared frame by frame and the camera
 * sequence command by command.
 */
function modelMovingReplay(
  replay: Replay,
  frameTarget: { padding: ResolvedPadding; viewport: CameraViewport },
): { puck: PuckFrame[]; camera: CameraFrame[] } {
  const { rounds, roundFrames, msPerFrame } = replay;
  const legs = approachLegs();
  let cameraBearing: number | null = null;
  const roundMs = roundFrames * msPerFrame;
  const fixStepMeters = (SPEED_MPS * roundMs) / 1000;
  const puck: PuckFrame[] = [];
  const camera: CameraFrame[] = [];
  let displayed = START_ALONG;
  let displayedBearing: number | null = positionAt(geometry, cum, START_ALONG).bearing;
  let displayedZoom = ENTER_ZOOM;
  let displayedPitch = 55;
  let lastFrame: number | null = null;
  let lastCam: {
    lng: number;
    lat: number;
    bearing: number;
    zoom: number;
    pitch: number;
  } | null = null;
  let now = CLOCK_START;
  let frame = 0;

  for (let round = 0; round < rounds; round += 1) {
    const fixAlongMeters = START_ALONG + fixStepMeters * round;
    const fixAtMs = CLOCK_START + roundMs * round;
    for (let i = 0; i < roundFrames; i += 1) {
      now += msPerFrame;
      const dt = lastFrame === null ? 0 : (now - lastFrame) / 1000;
      lastFrame = now;
      displayed = stepDeadReckon(
        displayed,
        { fixAlongMeters, speedMps: SPEED_MPS, ageSeconds: (now - fixAtMs) / 1000 },
        dt,
        { tauSeconds: 0.45, maxLeadSeconds: 1.5, routeLengthMeters },
      );
      const { point, bearing } = positionAt(geometry, cum, displayed);
      const bearingAlpha = 1 - Math.exp(-Math.max(dt, 0) / 0.35);
      displayedBearing = easeAngle(displayedBearing ?? bearing, bearing, bearingAlpha);
      puck.push({ lng: point[0], lat: point[1], rotation: displayedBearing });
      // The camera aims a few seconds along the route, with its own filter.
      const cameraTarget =
        lookAheadBearing(geometry, cum, displayed, lookAheadMeters(SPEED_MPS)) ?? bearing;
      cameraBearing = easeAngle(cameraBearing ?? cameraTarget, cameraTarget, bearingAlpha);

      if (now < SETTLE_UNTIL) {
        lastCam = null;
      } else {
        // Approach window active throughout the replay (driving, 100 m out):
        // the zoom target pushes in from the speed zoom until the maneuver's
        // legs fit (capped at 17.5) and the pitch leans in, both eased with
        // their own time constants.
        const zAlpha = 1 - Math.exp(-Math.max(dt, 0) / 1.6);
        const plain = speedZoom(SPEED_MPS, "2d");
        const zoomTarget = approachTargetZoom(
          plain,
          junctionFitZoom({
            legs,
            center: point,
            bearing: cameraBearing,
            pitch: displayedPitch,
            viewport: frameTarget.viewport,
            padding: frameTarget.padding,
            maxZoom: 17.5,
          }),
          17.5,
        );
        const approaching = true;
        displayedZoom = displayedZoom + (zoomTarget - displayedZoom) * zAlpha;
        const tAlpha = 1 - Math.exp(-Math.max(dt, 0) / 1.0);
        displayedPitch = displayedPitch + ((approaching ? 60 : 55) - displayedPitch) * tAlpha;
        const moved =
          !lastCam ||
          Math.abs(point[0] - lastCam.lng) > 1e-6 ||
          Math.abs(point[1] - lastCam.lat) > 1e-6 ||
          Math.abs(((cameraBearing - lastCam.bearing + 540) % 360) - 180) > 0.05 ||
          Math.abs(displayedZoom - lastCam.zoom) > 0.004 ||
          Math.abs(displayedPitch - lastCam.pitch) > 0.2;
        if (moved) {
          camera.push({
            frame,
            center: [point[0], point[1]],
            bearing: cameraBearing,
            zoom: displayedZoom,
          });
          lastCam = {
            lng: point[0],
            lat: point[1],
            bearing: cameraBearing,
            zoom: displayedZoom,
            pitch: displayedPitch,
          };
        }
      }
      frame += 1;
    }
  }
  return { puck, camera };
}

function startRoute(): void {
  useNavigationStore.getState().startGroundNavigation(route, "driving", [
    [0, 0],
    [0.02, 0.003],
  ]);
}

interface Harness {
  fake: FakeMap;
  frames: FrameHarness;
  marker(): MarkerRecord;
  unmount(): void;
  rerender(): void;
}

/**
 * Mount the hook on a ready map with navigation already running, and let the
 * asynchronous Marker import settle so the first flushed frame has everything
 * it needs.
 */
async function mountNavCamera(
  options: {
    startNavigation?: boolean;
    surface?: { padding: ResolvedPadding; maxPitch: number };
  } = {},
): Promise<Harness> {
  const frames = createFrameHarness(CLOCK_START);
  vi.stubGlobal("requestAnimationFrame", frames.request);
  vi.stubGlobal("cancelAnimationFrame", frames.cancel);
  vi.spyOn(performance, "now").mockImplementation(() => frames.now());

  const fake = createFakeMap({ zoom: 10 });
  mapContextTest.mapRef.current = fake.map;
  mapContextTest.mapReady = true;
  if (options.startNavigation !== false) startRoute();

  const surface = options.surface;
  const view = renderHook(() => useNavCamera(surface));
  await act(async () => {
    await Promise.resolve();
  });

  return {
    fake,
    frames,
    marker: () => nth(markerTest.markers, 0),
    unmount: () => view.unmount(),
    rerender: () => view.rerender(),
  };
}

/** The padding carried by the most recent camera transform, if any. */
function lastJumpPadding(fake: FakeMap): ResolvedPadding | undefined {
  const jumps = fake.state.cameraTransitions.filter((t) => t.method === "jumpTo");
  return jumps.at(-1)?.options.padding as ResolvedPadding | undefined;
}

function applyFix(alongMeters: number, speedMps = SPEED_MPS): void {
  act(() => {
    useNavigationStore.getState().applyProgress(makeProgress(alongMeters, speedMps));
  });
}

function applyApproachFix(
  alongMeters: number,
  speedMps: number,
  distanceToNextManeuver: number,
): void {
  act(() => {
    useNavigationStore
      .getState()
      .applyProgress(makeProgress(alongMeters, speedMps, distanceToNextManeuver));
  });
}

/**
 * Drive the hook through a moving replay one frame at a time, recording what
 * the puck showed on every frame and which frame issued each camera command.
 */
function runMovingReplay(
  harness: Harness,
  replay: Replay,
): { puck: PuckFrame[]; camera: CameraFrame[] } {
  const { fake, frames, marker } = harness;
  const fixStepMeters = (SPEED_MPS * replay.roundFrames * replay.msPerFrame) / 1000;
  const puck: PuckFrame[] = [];
  const camera: CameraFrame[] = [];
  let seen = 0;
  let frame = 0;
  for (let round = 0; round < replay.rounds; round += 1) {
    applyFix(START_ALONG + fixStepMeters * round);
    for (let i = 0; i < replay.roundFrames; i += 1) {
      frames.flush(1, replay.msPerFrame);
      const m = marker();
      puck.push({ lng: m.lngLat[0], lat: m.lngLat[1], rotation: m.rotation });
      const jumps = fake.state.cameraTransitions.filter((t) => t.method === "jumpTo");
      for (const jump of jumps.slice(seen)) {
        camera.push({
          frame,
          center: jump.options.center as [number, number],
          bearing: jump.options.bearing as number,
          zoom: jump.options.zoom as number,
        });
      }
      seen = jumps.length;
      frame += 1;
    }
  }
  return { puck, camera };
}

beforeEach(() => {
  useNavigationStore.getState().stopNavigation();
  useSettingsStore.setState({ mapNorthUp: false });
  markerTest.markers.length = 0;
  mapContextTest.mapRef.current = null;
  mapContextTest.mapReady = false;
  mapContextTest.styleVersion = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useNavigationStore.getState().stopNavigation();
});

const REPLAY_60HZ: Replay = { rounds: 10, roundFrames: ROUND_FRAMES, msPerFrame: FRAME_MS };
const REPLAY_120HZ: Replay = { rounds: 10, roundFrames: 120, msPerFrame: 8 };

describe("useNavCamera moving replay", () => {
  it.each([REPLAY_60HZ, REPLAY_120HZ])(
    "preserves moving poses and one continuous frame loop at $roundFrames frames per fix",
    async (replay) => {
      const harness = await mountNavCamera();
      const beforeSetters = harness.marker().setLngLatCount;
      const beforeRequests = harness.frames.requests();
      const actual = runMovingReplay(harness, replay);
      const expected = modelMovingReplay(
        replay,
        getCameraFrameTarget(
          harness.fake.map as unknown as Parameters<typeof getCameraFrameTarget>[0],
        ),
      );
      const total = replay.rounds * replay.roundFrames;
      expect(actual.puck).toHaveLength(total);
      expect(actual.puck).toEqual(expected.puck);
      expect(actual.camera).toEqual(expected.camera);
      expect(harness.marker().setLngLatCount - beforeSetters).toBe(total);
      expect(harness.frames.requests() - beforeRequests).toBe(total);
      expect(harness.marker().addToCount).toBe(1);
      expect(harness.marker().removeCount).toBe(0);
    },
  );
});

describe("useNavCamera quiescence", () => {
  it("stops scheduling frames when navigation starts without a fix", async () => {
    const { frames } = await mountNavCamera();
    frames.flush(120, FRAME_MS);
    expect(frames.pending()).toBe(0);
    // Only the enter-follow ease window keeps it awake at startup.
    expect(frames.requests()).toBeLessThan(30);
  });

  it("stops scheduling frames once a stationary pose has converged", async () => {
    const { fake, frames, marker } = await mountNavCamera();
    applyFix(START_ALONG, 0);
    frames.flush(1200, FRAME_MS);
    expect(frames.pending()).toBe(0);
    const settled = frames.requests();
    // The standstill auto-zoom is the last thing to converge. It runs until it
    // has arrived rather than until its steps turn too small to publish (which
    // left it short), and that still takes seconds, not the rest of the trip.
    expect(settled).toBeLessThan(900);
    const zoom = fake.state.cameraTransitions.filter((t) => t.method === "jumpTo").at(-1)?.options
      .zoom as number;
    // The default fix is 100 m from the maneuver, inside the approach window:
    // the standstill zoom plus the approach boost, capped at 17.5.
    const approachZoom = Math.min(targetZoomForSpeed(0) + 1, 17.5);
    expect(Math.abs(zoom - approachZoom)).toBeLessThanOrEqual(2 * CAMERA_ZOOM_EPSILON);
    const setters = marker().setLngLatCount;
    const transitions = fake.state.cameraTransitions.length;
    frames.flush(300, FRAME_MS);
    expect(frames.requests()).toBe(settled);
    expect(marker().setLngLatCount).toBe(setters);
    expect(fake.state.cameraTransitions).toHaveLength(transitions);
    expect(marker().addToCount).toBe(1);
    expect(marker().removeCount).toBe(0);
  });

  it("comes to rest a bounded number of frames after a moving trip stops", async () => {
    const harness = await mountNavCamera();
    runMovingReplay(harness, REPLAY_60HZ);
    // The traveller stops where the last fix put them; the filters have to
    // unwind the dead-reckoned lead and the standstill auto-zoom before the
    // pose stops changing.
    applyFix(START_ALONG + FIX_STEP_METERS * 9, 0);
    const before = harness.frames.requests();
    harness.frames.flush(2000, FRAME_MS);
    expect(harness.frames.pending()).toBe(0);
    expect(harness.frames.requests() - before).toBeLessThan(900);
  });
});

describe("useNavCamera wake sources", () => {
  async function settled() {
    const harness = await mountNavCamera();
    applyFix(START_ALONG, 0);
    harness.frames.flush(1200, FRAME_MS);
    expect(harness.frames.pending()).toBe(0);
    return harness;
  }

  it("wakes on a new fix", async () => {
    const { frames, marker } = await settled();
    const before = marker().lngLat[0];
    applyFix(START_ALONG + 40, 10);
    expect(frames.pending()).toBe(1);
    frames.flush(120, FRAME_MS);
    expect(marker().lngLat[0]).toBeGreaterThan(before);
  });

  it("wakes on a route replacement", async () => {
    const { frames } = await settled();
    act(() => {
      useNavigationStore.getState().applyReroute({ ...route, distance: 999 } as Route);
    });
    expect(frames.pending()).toBe(1);
  });

  it("wakes on a camera-mode change back to follow", async () => {
    const { frames } = await settled();
    act(() => useNavigationStore.getState().setCameraMode("free"));
    frames.flush(10, FRAME_MS);
    act(() => useNavigationStore.getState().setCameraMode("follow"));
    expect(frames.pending()).toBe(1);
  });

  it("wakes on a coasting change", async () => {
    const { frames } = await settled();
    act(() => useNavigationStore.getState().setCoasting(true));
    expect(frames.pending()).toBe(1);
  });

  it("keeps gliding on the 4 Hz extrapolated ticks of a GPS outage", async () => {
    const { frames, marker } = await settled();
    act(() => useNavigationStore.getState().setCoasting(true));
    let along = START_ALONG;
    for (let tick = 0; tick < 8; tick += 1) {
      const before = marker().lngLat[0];
      along += 5;
      applyFix(along, 20);
      // A coast tick lands every 250 ms; frames in between keep interpolating.
      frames.flush(16, FRAME_MS);
      expect(marker().lngLat[0]).toBeGreaterThan(before);
    }
  });

  it("wakes when the north-up setting is toggled", async () => {
    const { fake, frames } = await settled();
    const before = fake.state.cameraTransitions.length;
    act(() => useSettingsStore.setState({ mapNorthUp: true }));
    expect(frames.pending()).toBe(1);
    frames.flush(10, FRAME_MS);
    expect(fake.state.cameraTransitions.length).toBeGreaterThan(before);
    expect(fake.state.cameraTransitions.at(-1)?.options.bearing).toBe(0);
  });

  it("wakes when a gesture ends", async () => {
    const { fake, frames } = await settled();
    act(() => fake.emit("touchstart"));
    frames.flush(60, FRAME_MS);
    act(() => fake.emit("touchend", { originalEvent: { touches: [] } }));
    expect(frames.pending()).toBe(1);
  });

  it("wakes when the marker import resolves after the loop started", async () => {
    const frames = createFrameHarness(CLOCK_START);
    vi.stubGlobal("requestAnimationFrame", frames.request);
    vi.stubGlobal("cancelAnimationFrame", frames.cancel);
    vi.spyOn(performance, "now").mockImplementation(() => frames.now());
    const fake = createFakeMap({ zoom: 10 });
    mapContextTest.mapRef.current = fake.map;
    mapContextTest.mapReady = true;
    startRoute();

    renderHook(() => useNavCamera());
    // Let the enter-follow hold window lapse before the Marker module resolves.
    frames.flush(120, FRAME_MS);
    expect(frames.pending()).toBe(0);
    await act(async () => {
      await Promise.resolve();
    });
    expect(frames.pending()).toBe(1);
  });
});

describe("useNavCamera lifecycle", () => {
  it("removes the marker exactly once when navigation stops", async () => {
    const { frames, marker } = await mountNavCamera();
    applyFix(START_ALONG);
    frames.flush(60, FRAME_MS);
    act(() => useNavigationStore.getState().stopNavigation());
    expect(marker().removeCount).toBe(1);
    expect(marker().addToCount).toBe(1);
    frames.flush(60, FRAME_MS);
    expect(marker().removeCount).toBe(1);
    expect(frames.pending()).toBe(0);
  });

  it("removes the marker exactly once on unmount", async () => {
    const { frames, marker, unmount } = await mountNavCamera();
    applyFix(START_ALONG);
    frames.flush(60, FRAME_MS);
    act(() => unmount());
    expect(marker().removeCount).toBe(1);
    expect(frames.pending()).toBe(0);
  });

  it("re-attaches to a replacement map without leaking the old attachment", async () => {
    const { frames, marker } = await mountNavCamera();
    applyFix(START_ALONG);
    frames.flush(60, FRAME_MS);
    expect(marker().addToCount).toBe(1);

    const replacement = createFakeMap({ zoom: 10 });
    mapContextTest.mapRef.current = replacement.map;
    applyFix(START_ALONG + FIX_STEP_METERS);
    frames.flush(60, FRAME_MS);

    expect(marker().addToCount).toBe(2);
    expect(marker().map).toBe(replacement.map);
    expect(replacement.state.cameraTransitions.some((t) => t.method === "jumpTo")).toBe(true);
  });

  /**
   * The page swaps in a new map without clearing `mapReady` (a style rebuild,
   * or the map being re-created), so navigation can start in the gap where
   * `mapRef` is empty. `styleVersion` is what announces the new map.
   */
  async function mountDuringMapReplacement() {
    const frames = createFrameHarness(CLOCK_START);
    vi.stubGlobal("requestAnimationFrame", frames.request);
    vi.stubGlobal("cancelAnimationFrame", frames.cancel);
    vi.spyOn(performance, "now").mockImplementation(() => frames.now());
    mapContextTest.mapRef.current = null;
    mapContextTest.mapReady = true;
    startRoute();
    const view = renderHook(() => useNavCamera());
    await act(async () => {
      await Promise.resolve();
    });
    const fake = createFakeMap({ zoom: 10 });
    mapContextTest.mapRef.current = fake.map;
    mapContextTest.styleVersion += 1;
    view.rerender();
    await act(async () => {
      await Promise.resolve();
    });
    return { frames, fake, view };
  }

  it("draws the puck when navigation starts while the map is being replaced", async () => {
    const { frames, fake } = await mountDuringMapReplacement();
    expect(fake.state.cameraTransitions.some((t) => t.method === "easeTo")).toBe(true);
    applyFix(START_ALONG);
    frames.flush(60, FRAME_MS);

    expect(markerTest.markers[0]?.map).toBe(fake.map);
    expect(fake.state.cameraTransitions.some((t) => t.method === "jumpTo")).toBe(true);
  });

  it("enters follow again on a replacement map, and not on a style reload", async () => {
    const harness = await mountNavCamera();
    applyFix(START_ALONG);
    harness.frames.flush(60, FRAME_MS);
    const eases = (fake: FakeMap) =>
      fake.state.cameraTransitions.filter((t) => t.method === "easeTo").length;
    const before = eases(harness.fake);

    // A style reload keeps the map, and the camera the user is following.
    mapContextTest.styleVersion += 1;
    harness.rerender();
    expect(eases(harness.fake)).toBe(before);

    // A new map starts from its own default camera and needs follow re-entered.
    const replacement = createFakeMap({ zoom: 10 });
    mapContextTest.mapRef.current = replacement.map;
    mapContextTest.styleVersion += 1;
    harness.rerender();
    expect(eases(replacement)).toBe(1);
  });

  it("does not attach a marker that arrives after navigation stopped", async () => {
    const frames = createFrameHarness(CLOCK_START);
    vi.stubGlobal("requestAnimationFrame", frames.request);
    vi.stubGlobal("cancelAnimationFrame", frames.cancel);
    vi.spyOn(performance, "now").mockImplementation(() => frames.now());
    const fake = createFakeMap({ zoom: 10 });
    mapContextTest.mapRef.current = fake.map;
    mapContextTest.mapReady = true;
    startRoute();

    renderHook(() => useNavCamera());
    act(() => useNavigationStore.getState().stopNavigation());
    await act(async () => {
      await Promise.resolve();
    });
    frames.flush(60, FRAME_MS);

    expect(markerTest.markers[0]?.addToCount ?? 0).toBe(0);
  });

  it("positions the puck at subpixel precision so it can't flicker against the camera", async () => {
    // MapLibre otherwise rounds a marker to whole pixels on every update except
    // `move`, so a puck centred on a half pixel alternates between neighbours.
    const { marker } = await mountNavCamera();
    expect(marker().options.subpixelPositioning).toBe(true);
  });

  it("fades the puck element while coasting", async () => {
    const { marker } = await mountNavCamera();
    act(() => useNavigationStore.getState().setCoasting(true));
    expect(marker().getElement().style.opacity).toBe("0.5");
    act(() => useNavigationStore.getState().setCoasting(false));
    expect(marker().getElement().style.opacity).toBe("1");
  });
});

describe("useNavCamera camera ownership", () => {
  it("releases the camera to free mode but keeps moving the puck", async () => {
    const { fake, frames, marker } = await mountNavCamera();
    applyFix(START_ALONG);
    frames.flush(60, FRAME_MS);
    const transitions = fake.state.cameraTransitions.length;
    const position = marker().lngLat[0];

    act(() => fake.emit("dragstart", {}));
    expect(useNavigationStore.getState().cameraMode).toBe("free");
    applyFix(START_ALONG + FIX_STEP_METERS);
    frames.flush(60, FRAME_MS);

    expect(fake.state.cameraTransitions).toHaveLength(transitions);
    expect(marker().lngLat[0]).toBeGreaterThan(position);
  });

  it("issues no camera transform while a pointer is down", async () => {
    const { fake, frames } = await mountNavCamera();
    applyFix(START_ALONG);
    frames.flush(60, FRAME_MS);
    const transitions = fake.state.cameraTransitions.length;

    act(() => fake.emit("touchstart"));
    applyFix(START_ALONG + FIX_STEP_METERS);
    frames.flush(60, FRAME_MS);
    expect(fake.state.cameraTransitions).toHaveLength(transitions);

    act(() => fake.emit("touchend", { originalEvent: { touches: [] } }));
    frames.flush(60, FRAME_MS);
    expect(fake.state.cameraTransitions.length).toBeGreaterThan(transitions);
  });

  it.each(["outside mouse release", "window blur"])(
    "resumes camera publication after recenter following %s",
    async (release) => {
      const { fake, frames } = await mountNavCamera();
      applyFix(START_ALONG);
      frames.flush(60, FRAME_MS);
      act(() => {
        fake.emit("mousedown");
        fake.emit("dragstart", {});
      });
      frames.flush(60, FRAME_MS);
      act(() => {
        if (release === "outside mouse release") document.dispatchEvent(new MouseEvent("mouseup"));
        else window.dispatchEvent(new Event("blur"));
        useNavigationStore.getState().setCameraMode("follow");
      });
      const jumps = fake.state.cameraTransitions.filter((t) => t.method === "jumpTo").length;
      applyFix(START_ALONG + FIX_STEP_METERS);
      frames.flush(120, FRAME_MS);
      expect(
        fake.state.cameraTransitions.filter((t) => t.method === "jumpTo").length,
      ).toBeGreaterThan(jumps);
    },
  );

  it("keeps the follow camera suspended until the final touch lifts", async () => {
    const { fake, frames } = await mountNavCamera();
    applyFix(START_ALONG);
    frames.flush(60, FRAME_MS);
    const transitions = fake.state.cameraTransitions.length;
    act(() => fake.emit("touchstart"));
    act(() => fake.emit("touchend", { originalEvent: { touches: [{}] } }));
    applyFix(START_ALONG + FIX_STEP_METERS);
    frames.flush(60, FRAME_MS);
    expect(fake.state.cameraTransitions).toHaveLength(transitions);
    act(() => fake.emit("touchend", { originalEvent: { touches: [] } }));
    frames.flush(60, FRAME_MS);
    expect(fake.state.cameraTransitions.length).toBeGreaterThan(transitions);
  });

  it("removes outside release listeners when navigation stops", async () => {
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    await mountNavCamera();
    act(() => useNavigationStore.getState().stopNavigation());
    expect(documentRemove).toHaveBeenCalledWith("mouseup", expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith("blur", expect.any(Function));
  });

  it("hands zoom to the user after a zoom gesture and stops commanding it", async () => {
    const { fake, frames } = await mountNavCamera();
    applyFix(START_ALONG);
    frames.flush(60, FRAME_MS);

    act(() => fake.emit("zoomstart", {}));
    frames.flush(60, FRAME_MS);
    applyFix(START_ALONG + FIX_STEP_METERS);
    frames.flush(60, FRAME_MS);

    const commanded = fake.state.cameraTransitions.filter(
      (t) => t.method === "jumpTo" && t.options.zoom !== undefined,
    );
    const uncommanded = fake.state.cameraTransitions.filter(
      (t) => t.method === "jumpTo" && t.options.zoom === undefined,
    );
    expect(commanded.length).toBeGreaterThan(0);
    expect(uncommanded.length).toBeGreaterThan(0);
    expect(useNavigationStore.getState().cameraMode).toBe("follow");
  });

  it("ignores its own programmatic camera events", async () => {
    const { fake, frames } = await mountNavCamera();
    applyFix(START_ALONG);
    frames.flush(60, FRAME_MS);
    act(() => fake.emit("dragstart", { programmatic: true }));
    expect(useNavigationStore.getState().cameraMode).toBe("follow");
  });

  it("re-engages the follow camera after a recenter", async () => {
    const { fake, frames } = await mountNavCamera();
    applyFix(START_ALONG);
    frames.flush(60, FRAME_MS);
    act(() => fake.emit("dragstart", {}));
    frames.flush(60, FRAME_MS);
    const transitions = fake.state.cameraTransitions.length;

    act(() => useNavigationStore.getState().setCameraMode("follow"));
    // The re-entry ease has to lapse before the per-frame camera takes over.
    frames.flush(120, FRAME_MS);

    expect(fake.state.cameraTransitions.length).toBeGreaterThan(transitions);
    expect(fake.state.cameraTransitions.at(-1)?.method).toBe("jumpTo");
  });

  describe("camera padding", () => {
    afterEach(() => {
      publishMapObstruction("test-nav-column", "left", null);
      publishMapObstruction("test-nav-sheet", "bottom", null);
    });

    it("enters follow with the obstruction insets plus the puck offset from the visible height", async () => {
      publishMapObstruction("test-nav-column", "left", 432);
      const { fake } = await mountNavCamera();
      const enter = fake.state.cameraTransitions.find((t) => t.method === "easeTo");
      expect(enter?.options.padding).toEqual({ top: 400, bottom: 0, left: 432, right: 0 });
    });

    it("eases the padding toward a new target inside the frame loop", async () => {
      const harness = await mountNavCamera();
      applyFix(START_ALONG);
      harness.frames.flush(30);
      act(() => publishMapObstruction("test-nav-sheet", "bottom", 200));
      harness.frames.flush(90);
      const jumps = harness.fake.state.cameraTransitions.filter((t) => t.method === "jumpTo");
      expect(jumps.at(-1)?.options.padding).toEqual({ top: 300, bottom: 200, left: 0, right: 0 });
      expect(harness.fake.state.padding).toEqual({ top: 300, bottom: 200, left: 0, right: 0 });
    });

    it("publishes intermediate padding on the way to a new target", async () => {
      const harness = await mountNavCamera();
      applyFix(START_ALONG);
      harness.frames.flush(30);
      act(() => publishMapObstruction("test-nav-sheet", "bottom", 200));
      // Five frames in, a 0.2 s time constant is well short of the target: the
      // camera has to show the journey, not the destination.
      harness.frames.flush(5);
      const padding = lastJumpPadding(harness.fake);
      expect(padding?.bottom).toBeGreaterThan(0);
      expect(padding?.bottom).toBeLessThan(200);
      expect(padding?.top).toBeGreaterThan(300);
      expect(padding?.top).toBeLessThan(400);
    });

    it("arrives exactly on a new target from a standing pose, however small the move", async () => {
      const harness = await mountNavCamera();
      // Hand zoom to the user first: the auto-zoom keeps creeping toward the
      // standstill zoom long after the pose is still, and a frame it publishes
      // would be indistinguishable from one the padding asked for. Well outside
      // the approach window too, so the pose itself is fully still.
      act(() => harness.fake.emit("zoomstart", {}));
      applyApproachFix(START_ALONG, 0, 3000);
      harness.frames.flush(1200);
      expect(harness.frames.pending()).toBe(0);
      let transitions = harness.fake.state.cameraTransitions.length;

      // Chrome that moves by less than a pixel cannot move the target at all —
      // it is resolved in whole pixels — so nothing reaches the camera.
      act(() => publishMapObstruction("test-nav-column", "left", 0.4));
      harness.frames.flush(60);
      expect(harness.fake.state.cameraTransitions).toHaveLength(transitions);

      // One pixel is worth publishing but not worth easing: every frame of an
      // ease toward it would fall under the publication threshold, so it is
      // spent in a single step that lands on the target rather than dying
      // part-way there.
      act(() => publishMapObstruction("test-nav-column", "left", 1));
      harness.frames.flush(60);
      expect(harness.fake.state.cameraTransitions).toHaveLength(transitions + 1);
      expect(lastJumpPadding(harness.fake)).toEqual({ top: 400, bottom: 0, left: 1, right: 0 });
      transitions = harness.fake.state.cameraTransitions.length;

      // A move worth easing takes many frames and still arrives exactly.
      act(() => publishMapObstruction("test-nav-column", "left", 432));
      harness.frames.flush(90);
      expect(harness.fake.state.cameraTransitions.length).toBeGreaterThan(transitions + 1);
      expect(lastJumpPadding(harness.fake)).toEqual({ top: 400, bottom: 0, left: 432, right: 0 });
    });

    it("keeps following the padding of a map that arrived after the loop mounted", async () => {
      const frames = createFrameHarness(CLOCK_START);
      vi.stubGlobal("requestAnimationFrame", frames.request);
      vi.stubGlobal("cancelAnimationFrame", frames.cancel);
      vi.spyOn(performance, "now").mockImplementation(() => frames.now());
      startRoute();
      const view = renderHook(() => useNavCamera());

      // A map that initialises late, or is rebuilt mid-trip, announces itself
      // through styleVersion alone: mapRef is one stable object, and mapReady
      // never goes back to false. Whatever binds to the map has to hear that,
      // or the padding target it cached is the last one this trip ever sees.
      const fake = createFakeMap({ zoom: 10 });
      mapContextTest.mapRef.current = fake.map;
      mapContextTest.mapReady = true;
      mapContextTest.styleVersion = 1;
      await act(async () => {
        view.rerender();
        await Promise.resolve();
      });

      applyFix(START_ALONG);
      frames.flush(60, FRAME_MS);
      act(() => publishMapObstruction("test-nav-sheet", "bottom", 200));
      frames.flush(120, FRAME_MS);

      expect(lastJumpPadding(fake)).toEqual({ top: 300, bottom: 200, left: 0, right: 0 });
      view.unmount();
    });

    it("resolves the padding target once per change instead of measuring every frame", async () => {
      const harness = await mountNavCamera();
      applyFix(START_ALONG);
      // Past the first frame: attaching the marker invalidates the seed the
      // enter-follow ease left, so every trip measures once from inside the
      // loop and the spy below would count that too.
      harness.frames.flush(60);

      // Resolving the target is the loop's only container measurement, and the
      // frame has already moved the puck by the time it would run — measuring
      // per frame would force a layout in the hottest loop in the app.
      const map = harness.fake.map as unknown as { getContainer: () => unknown };
      const measure = map.getContainer.bind(map);
      let measurements = 0;
      map.getContainer = () => {
        measurements += 1;
        return measure();
      };

      harness.frames.flush(60);
      expect(measurements).toBe(0);

      act(() => publishMapObstruction("test-nav-sheet", "bottom", 200));
      harness.frames.flush(60);
      expect(measurements).toBe(1);
    });

    it("leaves the padding for the sync component when navigation ends", async () => {
      const harness = await mountNavCamera();
      act(() => useNavigationStore.getState().stopNavigation());
      expect(harness.fake.state.cameraTransitions.some((t) => t.method === "setPadding")).toBe(
        false,
      );
    });
  });
});

describe("useNavCamera approach camera", () => {
  const APPROACH_SPEED = 30;
  const PLAIN_ZOOM = targetZoomForSpeed(APPROACH_SPEED);

  function lastJump(fake: FakeMap) {
    return fake.state.cameraTransitions.filter((t) => t.method === "jumpTo").at(-1)?.options;
  }

  it("approach zoom fits the junction legs between speed zoom and 17.5", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, APPROACH_SPEED, 200);
    // Long enough for the pitch (τ 1 s) and zoom (τ 1.6 s) to converge.
    harness.frames.flush(900, FRAME_MS);
    const options = lastJump(harness.fake);
    expect(options?.pitch).toBeGreaterThan(59);
    const frame = getCameraFrameTarget(
      harness.fake.map as unknown as Parameters<typeof getCameraFrameTarget>[0],
    );
    const fit = junctionFitZoom({
      legs: approachLegs(),
      center: options?.center as LngLat,
      bearing: options?.bearing as number,
      pitch: options?.pitch as number,
      viewport: frame.viewport,
      padding: frame.padding,
      maxZoom: 17.5,
    });
    const expected = approachTargetZoom(speedZoom(APPROACH_SPEED, "2d"), fit, 17.5);
    expect(expected).toBeGreaterThan(PLAIN_ZOOM);
    expect(options?.zoom).toBeCloseTo(expected, 1);
    expect(options?.zoom).toBeLessThanOrEqual(17.5);
  });

  it("keeps the plain driving pose far from the maneuver", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, APPROACH_SPEED, 3000);
    harness.frames.flush(240, FRAME_MS);
    const options = lastJump(harness.fake);
    expect(options?.pitch).toBe(55);
    expect(options?.zoom).toBeLessThan(PLAIN_ZOOM + 0.3);
  });

  it("keeps approaching the same maneuver through motorway speed jitter", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 33, 4000);
    harness.frames.flush(1200, FRAME_MS);

    for (const [along, speed, distance] of [
      [600, 33, 3050],
      [633, 34, 3017],
      [667, 33, 2983],
      [700, 34, 2950],
    ] as const) {
      applyApproachFix(along, speed, distance);
      harness.frames.flush(60, FRAME_MS);
    }
    // Both speeds have the same plain zoom (14). Once approach has started,
    // even the 33 m/s fix must keep closing toward 15 rather than reversing.
    expect(lastJump(harness.fake)?.zoom).toBeGreaterThan(14.7);
    expect(lastJump(harness.fake)?.pitch).toBeGreaterThan(59);
  });

  it("keeps approach emphasis when slowing before the same maneuver", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 33, 2900);
    harness.frames.flush(300, FRAME_MS);
    applyApproachFix(START_ALONG + 100, 0, 2800);
    harness.frames.flush(1200, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBeGreaterThan(59.5);
    expect(lastJump(harness.fake)?.zoom).toBeGreaterThan(17.4);
  });

  it("releases approach after retreating beyond the entry margin", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 33, 2900);
    harness.frames.flush(300, FRAME_MS);
    applyApproachFix(START_ALONG, 33, 3400);
    harness.frames.flush(600, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBeLessThan(55.2);
    expect(lastJump(harness.fake)?.zoom).toBeLessThan(14.1);
  });

  it("does not carry approach emphasis into the next maneuver", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 33, 2900);
    harness.frames.flush(300, FRAME_MS);
    act(() => {
      useNavigationStore.getState().applyProgress({
        ...makeProgress(START_ALONG + 100, 0, 2800),
        currentStepIndex: 1,
      });
    });
    harness.frames.flush(1200, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBeLessThan(55.2);
    expect(lastJump(harness.fake)?.zoom).toBeLessThan(17.1);
  });

  it("resets approach on a replacement route with the same step index", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 33, 2900);
    harness.frames.flush(300, FRAME_MS);
    act(() => {
      useNavigationStore.setState({
        route: { ...route },
        progress: makeProgress(START_ALONG, 0, 2800),
      });
    });
    harness.frames.flush(1200, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBeLessThan(55.2);
  });

  it("does not invent an approach maneuver on a geometry-only route", async () => {
    const harness = await mountNavCamera();
    act(() => {
      useNavigationStore.setState({ route: { ...route, steps: [] } });
    });
    applyApproachFix(START_ALONG, APPROACH_SPEED, 200);
    harness.frames.flush(300, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBe(55);
    expect(lastJump(harness.fake)?.zoom).toBeLessThan(PLAIN_ZOOM + 0.2);
  });

  it("brings the tilt all the way back for a traveller stopped when the window closes", async () => {
    const harness = await mountNavCamera();
    // Stopped at the light at the end of the ramp, still inside the window.
    applyApproachFix(START_ALONG, 0, 50);
    harness.frames.flush(1200, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBeGreaterThan(59.5);

    // The maneuver moves on while the car stands still: nothing moves the puck,
    // and each frame's pitch step is under the threshold that publishes it.
    applyApproachFix(START_ALONG, 0, 5000);
    harness.frames.flush(1200, FRAME_MS);
    expect(harness.frames.pending()).toBe(0);
    expect(Math.abs((lastJump(harness.fake)?.pitch as number) - 55)).toBeLessThanOrEqual(0.2);
  });

  it("raises the pitch but stops commanding zoom after the user zoomed", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, APPROACH_SPEED, 200);
    act(() => harness.fake.emit("zoomstart", {}));
    harness.frames.flush(240, FRAME_MS);
    const jumps = harness.fake.state.cameraTransitions.filter((t) => t.method === "jumpTo");
    expect(jumps.length).toBeGreaterThan(0);
    expect((jumps.at(-1)?.options.pitch as number) ?? 0).toBeGreaterThan(59);
    expect(jumps.every((t) => t.options.zoom === undefined)).toBe(true);
  });

  it("never tilts for walking", async () => {
    useNavigationStore.getState().stopNavigation();
    useNavigationStore.getState().startGroundNavigation(route, "walking", [
      [0, 0],
      [0.02, 0.003],
    ]);
    const harness = await mountNavCamera({ startNavigation: false });
    applyApproachFix(START_ALONG, 1.4, 20);
    harness.frames.flush(240, FRAME_MS);
    const jumps = harness.fake.state.cameraTransitions.filter((t) => t.method === "jumpTo");
    expect(jumps.length).toBeGreaterThan(0);
    expect(jumps.every((t) => (t.options.pitch as number) === 0)).toBe(true);
  });

  it("snaps the pitch on the first published frame under reduced motion", async () => {
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes("reduce"),
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, APPROACH_SPEED, 200);
    // Past the enter-follow settle window, so the per-frame loop owns the camera.
    harness.frames.flush(40, FRAME_MS);
    const firstJump = harness.fake.state.cameraTransitions.find((t) => t.method === "jumpTo");
    expect(firstJump?.options.pitch).toBe(60);
  });
});

describe("useNavCamera look-ahead and junction framing", () => {
  // 38 m before the bend at 668 m, where the route turns from east to north-east.
  const BEFORE_BEND = 630;

  function jumps(fake: FakeMap) {
    return fake.state.cameraTransitions.filter((t) => t.method === "jumpTo");
  }

  it("driving camera bearing leads into a bend while the puck keeps the local bearing", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(BEFORE_BEND, SPEED_MPS, 3000);
    harness.frames.flush(240, FRAME_MS);
    const cameraBearing = jumps(harness.fake).at(-1)?.options.bearing as number;
    const puckBearing = harness.marker().rotation;
    // The puck still points along the eastbound segment; the camera already
    // aims into the north-eastbound one ahead.
    expect(puckBearing).toBeCloseTo(90, 0);
    expect(cameraBearing).toBeLessThan(puckBearing - 5);
  });

  it.each([
    ["turn", "left", false],
    ["end of road", "sharp left", false],
    ["keep", "left", true],
  ] as const)(
    "inside the approach window of a %s %s the camera leads into it: %s",
    async (type, modifier, leads) => {
      const harness = await mountNavCamera({ startNavigation: false });
      const turning = {
        ...route,
        steps: route.steps.map((step, index) =>
          index === 1 ? { ...step, maneuver: { type, modifier } } : step,
        ),
      } as Route;
      act(() => {
        useNavigationStore.getState().startGroundNavigation(turning, "driving", [
          [0, 0],
          [0.02, 0.003],
        ]);
        useNavigationStore.getState().applyProgress(makeProgress(BEFORE_BEND, SPEED_MPS, 38));
      });
      harness.frames.flush(240, FRAME_MS);
      const cameraBearing = jumps(harness.fake).at(-1)?.options.bearing as number;
      // Before a junction turn the camera keeps to the street, where buildings
      // do not stand between it and the puck; a fork it still leads into.
      if (leads) expect(cameraBearing).toBeLessThan(harness.marker().rotation - 5);
      else expect(cameraBearing).toBeCloseTo(harness.marker().rotation, 0);
    },
  );

  it("draws the puck in the highlighted lane, the route position unchanged", async () => {
    const harness = await mountNavCamera();
    act(() =>
      useNavigationSceneStore.getState().setHighlightSpan({
        fromAlong: 400,
        toAlong: 650,
        rejoinAlong: 700,
        offsetMeters: 3,
      }),
    );
    applyApproachFix(START_ALONG, SPEED_MPS, 100);
    harness.frames.flush(240, FRAME_MS);
    // Eastbound on the first segment: 3 m to the right is 3 m south of the line.
    const [, lat] = harness.marker().lngLat;
    expect(-lat * 111_195).toBeCloseTo(3, 0);
    expect(useNavigationStore.getState().progress?.snapped[1]).toBe(0);
    act(() => useNavigationSceneStore.getState().setHighlightSpan(null));
  });

  it.each(["walking", "cycling"] as const)("%s keeps the local bearing", async (mode) => {
    const harness = await mountNavCamera({ startNavigation: false });
    act(() => {
      useNavigationStore.getState().startGroundNavigation(route, mode, [
        [0, 0],
        [0.02, 0.003],
      ]);
      useNavigationStore.getState().applyProgress(makeProgress(BEFORE_BEND, 1.4, 3000));
    });
    harness.frames.flush(240, FRAME_MS);
    const cameraBearing = jumps(harness.fake).at(-1)?.options.bearing as number;
    expect(cameraBearing).toBeCloseTo(harness.marker().rotation, 1);
  });

  it("north-up ignores the look-ahead", async () => {
    useSettingsStore.setState({ mapNorthUp: true });
    const harness = await mountNavCamera();
    applyApproachFix(BEFORE_BEND, SPEED_MPS, 3000);
    harness.frames.flush(240, FRAME_MS);
    expect(jumps(harness.fake).at(-1)?.options.bearing).toBe(0);
    expect(harness.marker().rotation).toBeCloseTo(90, 0);
  });

  it("a manual zoom disables framing", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 30, 200);
    harness.frames.flush(60, FRAME_MS);
    act(() => harness.fake.emit("zoomstart", {}));
    harness.frames.flush(60, FRAME_MS);
    const before = jumps(harness.fake).length;
    applyApproachFix(START_ALONG + 30, 30, 170);
    harness.frames.flush(240, FRAME_MS);
    const after = jumps(harness.fake).slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((jump) => jump.options.zoom === undefined)).toBe(true);
  });

  it("a reroute inside the approach window starts framing for the new route", async () => {
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 30, 200);
    harness.frames.flush(300, FRAME_MS);
    const rerouted = { ...route, distance: routeLengthMeters + 1 } as Route;
    act(() => {
      useNavigationStore.getState().applyReroute(rerouted);
      useNavigationStore.getState().applyProgress(makeProgress(START_ALONG, 30, 200));
    });
    harness.frames.flush(900, FRAME_MS);
    const zoom = jumps(harness.fake).at(-1)?.options.zoom as number;
    expect(zoom).toBeGreaterThan(speedZoom(30, "2d") + 0.3);
  });
});

describe("useNavCamera 3D profile", () => {
  const lastJump = (fake: FakeMap) =>
    fake.state.cameraTransitions.filter((t) => t.method === "jumpTo").at(-1)?.options;

  afterEach(() => {
    useNavigationSceneStore.getState().setActive(false);
  });

  it("3D scene drives at 62° and approaches at 68°", async () => {
    useNavigationSceneStore.getState().setActive(true);
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 13.9, 3000);
    harness.frames.flush(600, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBeCloseTo(62, 0);
    applyApproachFix(START_ALONG + 5, 13.9, 150);
    harness.frames.flush(600, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBeCloseTo(68, 0);
  });

  it("3D speed zoom reaches 16.6 at 50 km/h", async () => {
    useNavigationSceneStore.getState().setActive(true);
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 13.9, 3000);
    harness.frames.flush(900, FRAME_MS);
    expect(lastJump(harness.fake)?.zoom).toBeCloseTo(16.62, 1);
  });

  it("3D approach cap is 18", async () => {
    useNavigationSceneStore.getState().setActive(true);
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 0, 100);
    harness.frames.flush(900, FRAME_MS);
    const zoom = lastJump(harness.fake)?.zoom as number;
    expect(zoom).toBeGreaterThan(17.5);
    expect(zoom).toBeLessThanOrEqual(18);
  });

  it("a car surface stays 2D while the scene is active", async () => {
    useNavigationSceneStore.getState().setActive(true);
    const harness = await mountNavCamera({
      surface: { padding: { top: 0, bottom: 0, left: 0, right: 0 }, maxPitch: 25 },
    });
    applyApproachFix(START_ALONG, 13.9, 3000);
    harness.frames.flush(900, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBeLessThanOrEqual(25);
    expect(lastJump(harness.fake)?.zoom).toBeCloseTo(speedZoom(13.9, "2d"), 1);
  });

  it("switching 3D off eases back to 55°", async () => {
    // An earlier test in this file leaves a reduced-motion matchMedia behind.
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    useNavigationSceneStore.getState().setActive(true);
    const harness = await mountNavCamera();
    applyApproachFix(START_ALONG, 13.9, 3000);
    harness.frames.flush(600, FRAME_MS);
    act(() => useNavigationSceneStore.getState().setActive(false));
    harness.frames.flush(30, FRAME_MS);
    const midway = lastJump(harness.fake)?.pitch as number;
    expect(midway).toBeGreaterThan(55.5);
    expect(midway).toBeLessThan(62);
    harness.frames.flush(600, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBeCloseTo(55, 0);
  });

  it("motorcycle uses the driving values in 3D", async () => {
    useNavigationSceneStore.getState().setActive(true);
    const harness = await mountNavCamera({ startNavigation: false });
    act(() => {
      useNavigationStore.getState().startGroundNavigation(route, "motorcycle", [
        [0, 0],
        [0.02, 0.003],
      ]);
      useNavigationStore.getState().applyProgress(makeProgress(START_ALONG, 13.9, 3000));
    });
    harness.frames.flush(600, FRAME_MS);
    expect(lastJump(harness.fake)?.pitch).toBeCloseTo(62, 0);
  });
});
