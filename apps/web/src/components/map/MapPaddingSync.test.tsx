import { useNavigationStore } from "@openmapx/core";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameBoundsInstant, issueCameraRequest, jumpToView } from "@/lib/cameraFraming";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import { type CreateFakeMapOptions, createFakeMap, type FakeMap } from "@/test";

const reduced = { current: false };
vi.mock("@/lib/reducedMotion", () => ({ prefersReducedMotion: () => reduced.current }));

const ctx = { mapRef: { current: null as unknown }, mapReady: true, styleVersion: 0 };
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ctx }));

import { MapPaddingSync, PADDING_EASE_MS } from "./MapPaddingSync";

const navInitial = useNavigationStore.getState();
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
const BOUNDS: [[number, number], [number, number]] = [
  [0, 0],
  [2, 2],
];

let rerender: (() => void) | null = null;

function mount(options: CreateFakeMapOptions = {}): FakeMap {
  const fake = createFakeMap({ containerWidth: 1200, containerHeight: 800, ...options });
  ctx.mapRef.current = fake.map;
  const rendered = render(<MapPaddingSync />);
  rerender = () => rendered.rerender(<MapPaddingSync />);
  return fake;
}

/** Collects animation frames instead of running them inline, and drains them. */
function manualFrames(): () => void {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  return () => {
    for (let pass = 0; pass < 10 && frames.length > 0; pass += 1) {
      for (const frame of frames.splice(0, frames.length)) frame(0);
    }
  };
}

const transitions = (fake: FakeMap) => fake.state.cameraTransitions;
const paddingOnlyEases = (fake: FakeMap) =>
  transitions(fake).filter((t) => t.options.padding !== undefined && !t.options.center);

describe("MapPaddingSync", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(performance, "now").mockReturnValue(5000);
    reduced.current = false;
  });

  afterEach(() => {
    cleanup();
    rerender = null;
    ctx.styleVersion = 0;
    publishMapObstruction("rail", "left", null);
    useNavigationStore.setState(navInitial, true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies the first target instantly and later ones with a programmatic ease", () => {
    publishMapObstruction("rail", "left", 400);
    const fake = mount();
    expect(transitions(fake).at(-1)).toMatchObject({
      method: "setPadding",
      options: { left: 400 },
      eventData: { programmatic: true },
    });
    act(() => publishMapObstruction("rail", "left", 0));
    expect(transitions(fake).at(-1)).toMatchObject({
      method: "easeTo",
      options: { padding: { left: 0 }, duration: PADDING_EASE_MS },
      eventData: { programmatic: true, paddingSync: true },
    });
  });

  it("does nothing when the map already carries the target", () => {
    publishMapObstruction("rail", "left", 400);
    const fake = mount();
    expect(transitions(fake).at(-1)?.method).toBe("setPadding");
    const before = transitions(fake).length;
    act(() => fake.emit("resize"));
    expect(transitions(fake)).toHaveLength(before);
  });

  it("defers during a user gesture and applies on moveend", () => {
    const fake = mount();
    act(() => fake.emit("movestart", {}));
    act(() => publishMapObstruction("rail", "left", 400));
    expect(transitions(fake).some((t) => t.method === "easeTo")).toBe(false);
    act(() => fake.emit("moveend", {}));
    expect(transitions(fake).at(-1)).toMatchObject({
      method: "easeTo",
      options: { padding: { left: 400 } },
    });
  });

  it("defers while a foreign programmatic animation is in flight", () => {
    const fake = mount();
    act(() => fake.emit("movestart", { programmatic: true }));
    act(() => publishMapObstruction("rail", "left", 400));
    expect(transitions(fake).some((t) => t.method === "easeTo")).toBe(false);
    act(() => fake.emit("moveend", { programmatic: true }));
    expect(transitions(fake).at(-1)?.method).toBe("easeTo");
  });

  it("retargets an in-flight framing request instead of easing", () => {
    const fake = mount();
    act(() =>
      issueCameraRequest(fake.map, {
        kind: "flyTo",
        center: [8, 50],
        zoom: 15,
        duration: 1500,
        startedAt: 4900,
        padding: NO_PADDING,
      }),
    );
    act(() => publishMapObstruction("rail", "left", 400));
    expect(transitions(fake).at(-1)).toMatchObject({
      method: "easeTo",
      options: { center: [8, 50], padding: { left: 400 }, duration: 1400 },
      eventData: { programmatic: true, cameraRequest: true },
    });
    expect(paddingOnlyEases(fake)).toHaveLength(0);
  });

  it("keeps a framing request alive across repeated retargets", () => {
    const flush = manualFrames();
    const fake = mount({ emitCameraEvents: true });
    flush();
    act(() =>
      issueCameraRequest(fake.map, {
        kind: "flyTo",
        center: [8, 50],
        zoom: 15,
        duration: 1500,
        startedAt: 5000,
        padding: NO_PADDING,
      }),
    );
    act(() => {
      publishMapObstruction("rail", "left", 400);
      flush();
    });
    act(() => {
      publishMapObstruction("rail", "left", 200);
      flush();
    });
    expect(transitions(fake).at(-1)).toMatchObject({
      method: "flyTo",
      options: { center: [8, 50], padding: { left: 200 } },
      eventData: { programmatic: true, cameraRequest: true },
    });
    expect(paddingOnlyEases(fake)).toHaveLength(0);
  });

  it("lets its own padding ease run instead of restarting it from where it got to", () => {
    const flush = manualFrames();
    const fake = mount({ emitCameraEvents: true, deferAnimatedCamera: true });
    flush();
    act(() => {
      publishMapObstruction("rail", "left", 400);
      flush();
    });
    expect(paddingOnlyEases(fake)).toHaveLength(1);

    // A click anywhere on the map mid-ease re-evaluates. The padding is only
    // part of the way to the target, and easing again from there would decay
    // the slide geometrically instead of finishing it.
    act(() => {
      fake.emit("mouseup", { originalEvent: {} });
      flush();
    });
    act(() => {
      fake.emit("mouseup", { originalEvent: {} });
      flush();
    });
    expect(paddingOnlyEases(fake)).toHaveLength(1);

    act(() => {
      fake.settleCameraAnimation();
      flush();
    });
    expect(paddingOnlyEases(fake)).toHaveLength(1);
    expect(fake.state.padding).toMatchObject({ left: 400 });
  });

  it("re-aims its own ease at a target that moves while it runs", () => {
    const flush = manualFrames();
    const fake = mount({ emitCameraEvents: true, deferAnimatedCamera: true });
    flush();
    act(() => {
      publishMapObstruction("rail", "left", 400);
      flush();
    });
    act(() => {
      publishMapObstruction("rail", "left", 200);
      flush();
    });
    const eases = paddingOnlyEases(fake);
    expect(eases).toHaveLength(2);
    expect(eases.at(-1)).toMatchObject({ options: { padding: { left: 200 } } });
  });

  it("binds to the map that replaced the one it mounted with", () => {
    const first = mount();
    const second = createFakeMap({ containerWidth: 1200, containerHeight: 800 });
    ctx.mapRef.current = second.map;
    act(() => {
      ctx.styleVersion += 1;
      rerender?.();
    });
    act(() => publishMapObstruction("rail", "left", 400));
    expect(transitions(second).at(-1)).toMatchObject({ options: { padding: { left: 400 } } });
    expect(transitions(first)).toHaveLength(0);
  });

  it("re-frames an instant request against chrome that registers right after it", () => {
    const fake = mount({ emitCameraEvents: true });
    // A deep link frames its bounds before opening the panel that will cover
    // part of the map; shifting the drawn centre afterwards would push the far
    // edge of the box off screen instead of re-fitting it.
    act(() => frameBoundsInstant(fake.map, BOUNDS));
    act(() => publishMapObstruction("rail", "left", 400));
    expect(transitions(fake).at(-1)).toMatchObject({
      method: "jumpTo",
      options: { center: [1, 1], padding: { left: 400 } },
      eventData: { programmatic: true, cameraRequest: true },
    });
  });

  it("keeps easing after a resize whose target is already on the map", () => {
    const fake = mount();
    act(() => publishMapObstruction("rail", "left", 400));
    expect(transitions(fake).at(-1)?.method).toBe("easeTo");
    act(() => fake.emit("resize"));
    act(() => publishMapObstruction("rail", "left", 200));
    expect(transitions(fake).at(-1)).toMatchObject({
      method: "easeTo",
      options: { padding: { left: 200 } },
    });
  });

  it("yields to the navigation follow camera", () => {
    const fake = mount();
    act(() =>
      useNavigationStore.setState({ status: "navigating", kind: "ground", cameraMode: "follow" }),
    );
    act(() => publishMapObstruction("rail", "left", 400));
    expect(transitions(fake).some((t) => t.method === "easeTo")).toBe(false);
    act(() => useNavigationStore.setState({ cameraMode: "overview" }));
    expect(transitions(fake).at(-1)?.method).toBe("easeTo");
  });

  it("never measures the container while the follow camera owns the padding", () => {
    const fake = mount();
    act(() =>
      useNavigationStore.setState({ status: "navigating", kind: "ground", cameraMode: "follow" }),
    );
    // The follow loop publishes a camera every frame, and each `moveend` lands
    // here: reading the container would force a layout per navigation frame.
    const getContainer = vi.spyOn(fake.map, "getContainer");
    act(() => fake.emit("moveend", { programmatic: true }));
    act(() => fake.emit("moveend", { programmatic: true }));
    expect(getContainer).not.toHaveBeenCalled();
  });

  it("jumps under reduced motion", () => {
    reduced.current = true;
    const fake = mount();
    act(() => publishMapObstruction("rail", "left", 400));
    expect(transitions(fake).at(-1)?.method).toBe("setPadding");
  });

  it("jumps right after an instant view change, which keeps nothing to re-frame", () => {
    const fake = mount();
    vi.spyOn(performance, "now").mockReturnValue(4900);
    act(() => jumpToView(fake.map, { center: [8, 50] }));
    vi.spyOn(performance, "now").mockReturnValue(5000);
    act(() => publishMapObstruction("rail", "left", 400));
    expect(transitions(fake).at(-1)).toMatchObject({
      method: "setPadding",
      options: { left: 400 },
    });
  });

  it("publishes safe-area insets from the probe element", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      paddingTop: "44px",
      paddingBottom: "34px",
      paddingLeft: "0px",
      paddingRight: "0px",
    } as CSSStyleDeclaration);
    mount();
    expect(getMapObstructionInsets()).toMatchObject({ top: 44, bottom: 34 });
  });
});
