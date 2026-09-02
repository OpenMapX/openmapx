import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap } from "@/test";
import {
  activeCameraRequest,
  type CameraRequest,
  cameraForRequest,
  clearCameraRequest,
  compact,
  frameBoundsInstant,
  issueCameraRequest,
  jumpToView,
  lastInstantRequestAt,
  retargetCameraRequest,
  toInsets,
} from "./cameraFraming";
import type { ResolvedPadding } from "./cameraPadding";
import { publishMapObstruction } from "./mapObstructions";

const ZERO: ResolvedPadding = { top: 0, bottom: 0, left: 0, right: 0 };
const VIEWPORT = { width: 1200, height: 800 };

function fitRequest(inner: ResolvedPadding, target: ResolvedPadding): CameraRequest {
  return {
    kind: "fitBounds",
    bounds: [
      [0, 0],
      [2, 2],
    ],
    inner,
    duration: 0,
    startedAt: 0,
    padding: target,
  };
}

function flyRequest(padding: ResolvedPadding, duration: number, startedAt: number): CameraRequest {
  return { kind: "flyTo", center: [8, 50], zoom: 15, duration, startedAt, padding };
}

interface BoundsCall {
  padding: ResolvedPadding;
  offset: [number, number];
  maxZoom?: number;
}

function lastBoundsCall(fake: FakeMap): BoundsCall {
  const options = fake.state.cameraForBoundsCalls.at(-1)?.options;
  if (!options) throw new Error("cameraForBounds was never called");
  return options as unknown as BoundsCall;
}

/**
 * Where MapLibre lands the framed box on screen, given the arguments we handed
 * `cameraForBounds`. It frames at bearing 0 unless asked for another one, so
 * screen axes are world axes: the box sits at `offset` plus the asymmetry of
 * the padding argument away from the camera's padding-derived centre point.
 */
function framedBoxCentre(call: BoundsCall, target: ResolvedPadding): [number, number] {
  return [
    (target.left + VIEWPORT.width - target.right) / 2 +
      call.offset[0] +
      (call.padding.left - call.padding.right) / 2,
    (target.top + VIEWPORT.height - target.bottom) / 2 +
      call.offset[1] +
      (call.padding.top - call.padding.bottom) / 2,
  ];
}

/** The extent MapLibre has left to fit the box into, on both axes. */
function availableExtent(call: BoundsCall, current: ResolvedPadding): [number, number] {
  return [
    VIEWPORT.width - current.left - current.right - call.padding.left - call.padding.right,
    VIEWPORT.height - current.top - current.bottom - call.padding.top - call.padding.bottom,
  ];
}

describe("toInsets", () => {
  it("spreads a scalar over every edge", () => {
    expect(toInsets(24, 80)).toEqual({ top: 24, bottom: 24, left: 24, right: 24 });
  });

  it("fills the missing edges of an object with zero", () => {
    expect(toInsets({ left: 30 }, 80)).toEqual({ top: 0, bottom: 0, left: 30, right: 0 });
  });

  it("falls back when nothing is asked for", () => {
    expect(toInsets(undefined, 80)).toEqual({ top: 80, bottom: 80, left: 80, right: 80 });
  });
});

describe("compact", () => {
  it("drops undefined members and keeps falsy ones", () => {
    expect(compact({ zoom: undefined, bearing: 0, pitch: 45 })).toEqual({ bearing: 0, pitch: 45 });
  });
});

describe("cameraForRequest", () => {
  afterEach(() => {
    publishMapObstruction("test-panel", "left", null);
    vi.restoreAllMocks();
  });

  it("compacts an absent zoom out of a flyTo camera", () => {
    const fake = createFakeMap();
    const camera = cameraForRequest(fake.map, {
      kind: "flyTo",
      center: [8, 50],
      duration: 0,
      startedAt: 0,
      padding: ZERO,
    });
    expect(camera).toEqual({ center: [8, 50] });
  });

  it("frames the box in the middle of the visible strip when a panel covers the left", () => {
    const fake = createFakeMap({ containerWidth: 1200, containerHeight: 800 });
    const target: ResolvedPadding = { top: 0, bottom: 0, left: 400, right: 0 };
    cameraForRequest(fake.map, fitRequest(toInsets(80, 80), target));
    const call = lastBoundsCall(fake);
    expect(availableExtent(call, ZERO)).toEqual([640, 640]);
    expect(framedBoxCentre(call, target)).toEqual([800, 400]);
  });

  it("gives space back when the target is smaller than the map's current padding", () => {
    const fake = createFakeMap({ containerWidth: 1200, containerHeight: 800 });
    const current: ResolvedPadding = { top: 0, bottom: 0, left: 400, right: 0 };
    fake.map.setPadding(current);
    cameraForRequest(fake.map, fitRequest(toInsets(80, 80), ZERO));
    const call = lastBoundsCall(fake);
    expect(call.padding.left).toBe(-320);
    expect(availableExtent(call, current)).toEqual([1040, 640]);
    expect(framedBoxCentre(call, ZERO)).toEqual([600, 400]);
  });

  it("scales the breathing room down rather than asking for a non-positive extent", () => {
    const fake = createFakeMap({ containerWidth: 320, containerHeight: 800 });
    const target: ResolvedPadding = { top: 0, bottom: 0, left: 200, right: 0 };
    cameraForRequest(fake.map, fitRequest(toInsets(80, 80), target));
    const call = lastBoundsCall(fake);
    expect(call.padding.left).toBeCloseTo(259.5);
    expect(320 - call.padding.left - call.padding.right).toBeCloseTo(1);
  });

  it("frames a rotated map back to north with the box still centred", () => {
    const fake = createFakeMap({ containerWidth: 1200, containerHeight: 800, bearing: 90 });
    const target: ResolvedPadding = { top: 0, bottom: 0, left: 400, right: 0 };
    const camera = cameraForRequest(fake.map, fitRequest(toInsets(80, 80), target));
    const call = lastBoundsCall(fake);
    expect(call.offset).toEqual([-200, 0]);
    expect(framedBoxCentre(call, target)).toEqual([800, 400]);
    expect(camera?.bearing).toBe(0);
  });
});

describe("camera request tracking", () => {
  afterEach(() => {
    publishMapObstruction("test-panel", "left", null);
    vi.restoreAllMocks();
  });

  it("records the active request only once the animation has started", () => {
    const fake = createFakeMap({ emitCameraEvents: true });
    // What the padding sync does: every `moveend` drops the active request,
    // including the synchronous one that starting an animation fires for the
    // animation it replaces.
    fake.map.on("moveend", () => clearCameraRequest(fake.map));
    const startedAt = performance.now();
    issueCameraRequest(fake.map, flyRequest(ZERO, 1500, startedAt));
    issueCameraRequest(fake.map, flyRequest(ZERO, 1500, startedAt));
    expect(activeCameraRequest(fake.map)).not.toBeNull();
  });

  it("treats a request whose animation is over as absent", () => {
    const fake = createFakeMap();
    vi.spyOn(performance, "now").mockReturnValue(1000);
    issueCameraRequest(fake.map, flyRequest(ZERO, 500, 1000));
    expect(activeCameraRequest(fake.map)).not.toBeNull();
    vi.spyOn(performance, "now").mockReturnValue(1601);
    expect(activeCameraRequest(fake.map)).toBeNull();
  });

  it("re-issues a fresh retarget and eases the remainder of a late one", () => {
    const fake = createFakeMap({ zoom: 10 });
    vi.spyOn(performance, "now").mockReturnValue(1000);
    issueCameraRequest(fake.map, flyRequest(ZERO, 1500, 1000));
    const fresh = activeCameraRequest(fake.map);
    if (!fresh) throw new Error("no active request");
    retargetCameraRequest(fake.map, fresh, { top: 0, bottom: 0, left: 400, right: 0 });
    expect(fake.state.cameraTransitions.at(-1)).toMatchObject({
      method: "flyTo",
      options: { padding: { left: 400 } },
    });
    vi.spyOn(performance, "now").mockReturnValue(1900);
    const late = activeCameraRequest(fake.map);
    if (!late) throw new Error("no retargeted request");
    retargetCameraRequest(fake.map, late, ZERO);
    expect(fake.state.cameraTransitions.at(-1)).toMatchObject({
      method: "easeTo",
      options: { duration: 600, padding: { left: 0 } },
    });
  });
});

describe("instant framing", () => {
  afterEach(() => {
    publishMapObstruction("test-panel", "left", null);
    vi.restoreAllMocks();
  });

  it("frames bounds instantly against the visible viewport", () => {
    publishMapObstruction("test-panel", "left", 400);
    const fake = createFakeMap({ containerWidth: 1200, containerHeight: 800 });
    vi.spyOn(performance, "now").mockReturnValue(2000);
    frameBoundsInstant(fake.map, [
      [0, 0],
      [2, 2],
    ]);
    expect(fake.state.cameraTransitions.at(-1)).toMatchObject({
      method: "jumpTo",
      options: { center: [1, 1], padding: { left: 400 } },
      eventData: { programmatic: true, cameraRequest: true },
    });
    expect(lastInstantRequestAt(fake.map)).toBe(2000);
  });

  it("keeps an instant request retargetable for a bounded window", () => {
    const fake = createFakeMap({ containerWidth: 1200, containerHeight: 800 });
    vi.spyOn(performance, "now").mockReturnValue(2000);
    frameBoundsInstant(fake.map, [
      [0, 0],
      [2, 2],
    ]);
    const request = activeCameraRequest(fake.map);
    if (!request) throw new Error("no instant request on record");

    vi.spyOn(performance, "now").mockReturnValue(2200);
    retargetCameraRequest(fake.map, request, { top: 0, bottom: 0, left: 400, right: 0 });
    // Still instant, and re-fitted rather than merely re-centred: the caller
    // asked for no animation, and a late retarget must not invent one.
    expect(fake.state.cameraTransitions.at(-1)).toMatchObject({
      method: "jumpTo",
      options: { center: [1, 1], padding: { left: 400 } },
    });
    expect(fake.state.cameraForBoundsCalls).toHaveLength(2);

    // The window runs from the original framing, so a chain of retargets cannot
    // keep a long-finished one alive.
    vi.spyOn(performance, "now").mockReturnValue(2301);
    expect(activeCameraRequest(fake.map)).toBeNull();
  });

  it("jumps to a view keeping the padding and dropping absent fields", () => {
    publishMapObstruction("test-panel", "left", 400);
    const fake = createFakeMap({ containerWidth: 1200, containerHeight: 800 });
    jumpToView(fake.map, { center: [8, 50] });
    expect(fake.state.cameraTransitions.at(-1)?.options).toEqual({
      center: [8, 50],
      padding: { top: 0, bottom: 0, left: 400, right: 0 },
    });
  });
});
