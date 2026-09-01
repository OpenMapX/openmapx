import { useNavigationStore } from "@openmapx/core";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueCameraRequest } from "@/lib/cameraFraming";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import { type CreateFakeMapOptions, createFakeMap, type FakeMap } from "@/test";

const reduced = { current: false };
vi.mock("@/lib/reducedMotion", () => ({ prefersReducedMotion: () => reduced.current }));

const ctx = { mapRef: { current: null as unknown }, mapReady: true };
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ctx }));

import { MapPaddingSync, PADDING_EASE_MS } from "./MapPaddingSync";

const navInitial = useNavigationStore.getState();
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };

function mount(options: CreateFakeMapOptions = {}): FakeMap {
  const fake = createFakeMap({ containerWidth: 1200, containerHeight: 800, ...options });
  ctx.mapRef.current = fake.map;
  render(<MapPaddingSync />);
  return fake;
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
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    const flush = () => {
      for (let pass = 0; pass < 10 && frames.length > 0; pass += 1) {
        for (const frame of frames.splice(0, frames.length)) frame(0);
      }
    };
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

  it("jumps under reduced motion and right after an instant request", () => {
    reduced.current = true;
    const fake = mount();
    act(() => publishMapObstruction("rail", "left", 400));
    expect(transitions(fake).at(-1)?.method).toBe("setPadding");
    reduced.current = false;
    vi.spyOn(performance, "now").mockReturnValue(4900);
    act(() =>
      issueCameraRequest(fake.map, {
        kind: "flyTo",
        center: [8, 50],
        zoom: 15,
        duration: 0,
        startedAt: 4900,
        padding: { top: 0, bottom: 0, left: 400, right: 0 },
      }),
    );
    vi.spyOn(performance, "now").mockReturnValue(5000);
    act(() => publishMapObstruction("rail", "left", 200));
    expect(transitions(fake).at(-1)?.method).toBe("setPadding");
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
