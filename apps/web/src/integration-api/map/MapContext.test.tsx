import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeCameraRequest, lastInstantRequestAt } from "@/lib/cameraFraming";
import { publishMapObstruction } from "@/lib/mapObstructions";
import { createFakeMap, type FakeMap } from "@/test";

const reduced = { current: false };
vi.mock("@/lib/reducedMotion", () => ({ prefersReducedMotion: () => reduced.current }));

import { type MapContextValue, MapProvider, useMap } from "./MapContext";

function setup(ready = true): { fake: FakeMap; ctx: () => MapContextValue } {
  const fake = createFakeMap({ zoom: 10, containerWidth: 1200, containerHeight: 800 });
  let value: MapContextValue | null = null;
  function Probe() {
    value = useMap();
    return null;
  }
  render(
    <MapProvider>
      <Probe />
    </MapProvider>,
  );
  if (ready) {
    act(() => {
      if (value?.mapRef) value.mapRef.current = fake.map;
      value?.notifyMapReady();
    });
  }
  return { fake, ctx: () => value as MapContextValue };
}

const last = (fake: FakeMap) => fake.state.cameraTransitions.at(-1);

describe("MapContext camera wrappers", () => {
  beforeEach(() => {
    reduced.current = false;
    vi.spyOn(performance, "now").mockReturnValue(1000);
  });
  afterEach(() => {
    publishMapObstruction("test-rail", "left", null);
    vi.restoreAllMocks();
  });

  it("flyTo carries the current padding target and records the request", () => {
    publishMapObstruction("test-rail", "left", 400);
    const { fake, ctx } = setup();
    act(() => ctx().flyTo([8, 50], 15));
    expect(last(fake)?.method).toBe("flyTo");
    expect(last(fake)?.options).toMatchObject({
      center: [8, 50],
      zoom: 15,
      duration: 1500,
      padding: { top: 0, bottom: 0, left: 400, right: 0 },
    });
    expect(last(fake)?.eventData).toMatchObject({ programmatic: true });
    expect(activeCameraRequest(fake.map)).toMatchObject({ kind: "flyTo", startedAt: 1000 });
  });

  it("fitBounds asks MapLibre for the target-padded camera and flies with the target", () => {
    publishMapObstruction("test-rail", "left", 400);
    const { fake, ctx } = setup();
    fake.map.setPadding({ top: 0, bottom: 0, left: 100, right: 0 });
    act(() =>
      ctx().fitBounds(
        [
          [0, 0],
          [2, 2],
        ],
        80,
        { maxZoom: 17 },
      ),
    );
    expect(fake.state.cameraForBoundsCalls.at(-1)?.options).toEqual({
      padding: { top: 80, bottom: 80, left: 380, right: 80 },
      offset: [-150, 0],
      maxZoom: 17,
    });
    expect(last(fake)).toMatchObject({
      method: "flyTo",
      options: { center: [1, 1], duration: 1000, padding: { left: 400 } },
    });
  });

  it("accepts object inner padding", () => {
    const { fake, ctx } = setup();
    act(() =>
      ctx().fitBounds(
        [
          [0, 0],
          [2, 2],
        ],
        { top: 10, bottom: 20, left: 30, right: 40 },
      ),
    );
    expect(fake.state.cameraForBoundsCalls.at(-1)?.options?.padding).toEqual({
      top: 10,
      bottom: 20,
      left: 30,
      right: 40,
    });
  });

  it("jumps instead of animating under reduced motion and stamps the instant request", () => {
    reduced.current = true;
    const { fake, ctx } = setup();
    act(() => ctx().flyTo([8, 50], 15));
    expect(last(fake)?.method).toBe("jumpTo");
    expect(last(fake)?.options).not.toHaveProperty("duration");
    expect(lastInstantRequestAt(fake.map)).toBe(1000);
    // Recorded like any other, so chrome opening alongside it can still be
    // framed against — instantly.
    expect(activeCameraRequest(fake.map)).toMatchObject({ kind: "flyTo", duration: 0 });
  });

  it("fits instantly under reduced motion, so callers never ask for that themselves", () => {
    reduced.current = true;
    const { fake, ctx } = setup();
    act(() =>
      ctx().fitBounds([
        [0, 0],
        [2, 2],
      ]),
    );
    expect(last(fake)?.method).toBe("jumpTo");
    expect(last(fake)?.options).not.toHaveProperty("duration");
  });

  it("queues flyTo until the map is ready and drains it as an instant jump with padding", () => {
    publishMapObstruction("test-rail", "left", 400);
    const { fake, ctx } = setup(false);
    act(() => ctx().flyTo([8, 50]));
    expect(fake.state.cameraTransitions).toHaveLength(0);
    act(() => {
      ctx().mapRef.current = fake.map;
      ctx().notifyMapReady();
    });
    expect(last(fake)).toMatchObject({
      method: "jumpTo",
      options: { center: [8, 50], zoom: 15, padding: { left: 400 } },
    });
  });

  it("resetBearing is programmatic", () => {
    const { fake, ctx } = setup();
    act(() => ctx().resetBearing());
    expect(last(fake)).toMatchObject({
      method: "easeTo",
      options: { bearing: 0, pitch: 0 },
      eventData: { programmatic: true },
    });
  });
});
