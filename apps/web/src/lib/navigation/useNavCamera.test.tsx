// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import type { LngLat, NavProgress } from "@openmapx/core";
import {
  cumulativeDistances,
  positionAt,
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
import { createFakeMap, type FakeMap } from "@/test";
import { useNavCamera } from "./useNavCamera";

interface MarkerRecord {
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
const routeLengthMeters = cum[cum.length - 1];
const route = {
  distance: routeLengthMeters,
  duration: 200,
  geometry,
  legs: [],
  mode: "driving",
  steps: [],
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

function makeProgress(alongMeters: number, speedMps: number): NavProgress {
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
    distanceToNextManeuver: 100,
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
function modelMovingReplay(replay: Replay): { puck: PuckFrame[]; camera: CameraFrame[] } {
  const { rounds, roundFrames, msPerFrame } = replay;
  const roundMs = roundFrames * msPerFrame;
  const fixStepMeters = (SPEED_MPS * roundMs) / 1000;
  const puck: PuckFrame[] = [];
  const camera: CameraFrame[] = [];
  let displayed = START_ALONG;
  let displayedBearing: number | null = positionAt(geometry, cum, START_ALONG).bearing;
  let displayedZoom = ENTER_ZOOM;
  let lastFrame: number | null = null;
  let lastCam: { lng: number; lat: number; bearing: number; zoom: number } | null = null;
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

      if (now < SETTLE_UNTIL) {
        lastCam = null;
      } else {
        const zAlpha = 1 - Math.exp(-Math.max(dt, 0) / 1.6);
        displayedZoom = displayedZoom + (targetZoomForSpeed(SPEED_MPS) - displayedZoom) * zAlpha;
        const moved =
          !lastCam ||
          Math.abs(point[0] - lastCam.lng) > 1e-6 ||
          Math.abs(point[1] - lastCam.lat) > 1e-6 ||
          Math.abs(((displayedBearing - lastCam.bearing + 540) % 360) - 180) > 0.05 ||
          Math.abs(displayedZoom - lastCam.zoom) > 0.004;
        if (moved) {
          camera.push({
            frame,
            center: [point[0], point[1]],
            bearing: displayedBearing,
            zoom: displayedZoom,
          });
          lastCam = {
            lng: point[0],
            lat: point[1],
            bearing: displayedBearing,
            zoom: displayedZoom,
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
async function mountNavCamera(options: { startNavigation?: boolean } = {}): Promise<Harness> {
  const frames = createFrameHarness(CLOCK_START);
  vi.stubGlobal("requestAnimationFrame", frames.request);
  vi.stubGlobal("cancelAnimationFrame", frames.cancel);
  vi.spyOn(performance, "now").mockImplementation(() => frames.now());

  const fake = createFakeMap({ zoom: 10 });
  mapContextTest.mapRef.current = fake.map;
  mapContextTest.mapReady = true;
  if (options.startNavigation !== false) startRoute();

  const view = renderHook(() => useNavCamera());
  await act(async () => {
    await Promise.resolve();
  });

  return {
    fake,
    frames,
    marker: () => markerTest.markers[0],
    unmount: () => view.unmount(),
    rerender: () => view.rerender(),
  };
}

function applyFix(alongMeters: number, speedMps = SPEED_MPS): void {
  act(() => {
    useNavigationStore.getState().applyProgress(makeProgress(alongMeters, speedMps));
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
      for (let k = seen; k < jumps.length; k += 1) {
        camera.push({
          frame,
          center: jumps[k].options.center as [number, number],
          bearing: jumps[k].options.bearing as number,
          zoom: jumps[k].options.zoom as number,
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
  it("reproduces the recorded puck and camera pose on every 60 Hz frame", async () => {
    const harness = await mountNavCamera();
    const actual = runMovingReplay(harness, REPLAY_60HZ);
    const expected = modelMovingReplay(REPLAY_60HZ);

    expect(actual.puck).toHaveLength(600);
    expect(actual.puck).toEqual(expected.puck);
    expect(actual.camera).toEqual(expected.camera);
  });

  it("reproduces the recorded puck and camera pose on every 120 Hz frame", async () => {
    const harness = await mountNavCamera();
    const actual = runMovingReplay(harness, REPLAY_120HZ);
    const expected = modelMovingReplay(REPLAY_120HZ);

    expect(actual.puck).toHaveLength(1200);
    expect(actual.puck).toEqual(expected.puck);
    expect(actual.camera).toEqual(expected.camera);
  });

  it("publishes the puck on every moving frame, so nothing is dropped", async () => {
    const harness = await mountNavCamera();
    const before = harness.marker().setLngLatCount;
    runMovingReplay(harness, REPLAY_60HZ);
    expect(harness.marker().setLngLatCount - before).toBe(600);
  });

  it("attaches the marker to the map exactly once across 600 frames", async () => {
    const harness = await mountNavCamera();
    runMovingReplay(harness, REPLAY_60HZ);
    expect(harness.marker().addToCount).toBe(1);
    expect(harness.marker().removeCount).toBe(0);
  });

  it("schedules exactly one animation frame per rendered frame while moving", async () => {
    const harness = await mountNavCamera();
    const before = harness.frames.requests();
    runMovingReplay(harness, REPLAY_60HZ);
    // The mount frame is already booked, so 600 frames book 600 successors.
    expect(harness.frames.requests() - before).toBe(600);
  });

  it("keeps at most one animation frame outstanding", async () => {
    const { frames } = await mountNavCamera();
    applyFix(START_ALONG);
    for (let i = 0; i < 120; i += 1) {
      frames.flush(1, FRAME_MS);
      expect(frames.pending()).toBeLessThanOrEqual(1);
    }
  });
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
    const { frames } = await mountNavCamera();
    applyFix(START_ALONG, 0);
    frames.flush(1200, FRAME_MS);
    expect(frames.pending()).toBe(0);
    const settled = frames.requests();
    // The standstill auto-zoom is the last thing to converge, and it does so in
    // a few seconds rather than for the rest of the trip.
    expect(settled).toBeLessThan(400);
    frames.flush(300, FRAME_MS);
    expect(frames.requests()).toBe(settled);
  });

  it("calls neither marker setters nor jumpTo once the pose has converged", async () => {
    const { fake, frames, marker } = await mountNavCamera();
    applyFix(START_ALONG, 0);
    frames.flush(1200, FRAME_MS);
    const setters = marker().setLngLatCount;
    const transitions = fake.state.cameraTransitions.length;
    frames.flush(300, FRAME_MS);
    expect(marker().setLngLatCount).toBe(setters);
    expect(fake.state.cameraTransitions).toHaveLength(transitions);
  });

  it("never removes or re-attaches the marker while it sleeps", async () => {
    const { frames, marker } = await mountNavCamera();
    applyFix(START_ALONG, 0);
    frames.flush(1200, FRAME_MS);
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
    expect(harness.frames.requests() - before).toBeLessThan(600);
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
});
