import { useParkingStore } from "@openmapx/core";
import type { Map as MaplibreMap } from "maplibre-gl";
import { afterEach, describe, expect, it } from "vitest";
import { getMapClickOwner, registerCustomMapHitTester } from "./mapClickOwnership";

const map = {} as MaplibreMap;
const point = { x: 10, y: 20 };

function clickEvent() {
  const originalEvent = new MouseEvent("click");
  return { target: map, point, originalEvent };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useParkingStore.setState({ picking: false });
});

describe("custom map hit testers", () => {
  it("custom hit marks the click owned before any handler runs", () => {
    cleanups.push(registerCustomMapHitTester(map, "landmarks", (p) => p.x === 10));
    const event = clickEvent();
    expect(getMapClickOwner(event)).toBe("custom-content");
    // A wrapper sharing the original DOM event sees the same owner.
    expect(getMapClickOwner({ originalEvent: event.originalEvent })).toBe("custom-content");
  });

  it("a picker still wins over custom content", () => {
    useParkingStore.setState({ picking: true });
    cleanups.push(registerCustomMapHitTester(map, "landmarks", () => true));
    expect(getMapClickOwner(clickEvent())).toBe("parking");
  });

  it("unregistering removes the tester", () => {
    const unregister = registerCustomMapHitTester(map, "landmarks", () => true);
    unregister();
    expect(getMapClickOwner(clickEvent())).toBeNull();
  });

  it("a throwing tester is ignored", () => {
    cleanups.push(
      registerCustomMapHitTester(map, "broken", () => {
        throw new Error("boom");
      }),
    );
    expect(getMapClickOwner(clickEvent())).toBeNull();
  });

  it("events without point or map ignore testers", () => {
    cleanups.push(registerCustomMapHitTester(map, "landmarks", () => true));
    expect(getMapClickOwner({ originalEvent: new MouseEvent("click") })).toBeNull();
    expect(getMapClickOwner({ target: map, originalEvent: new MouseEvent("click") })).toBeNull();
  });

  it("a miss leaves the click unowned", () => {
    cleanups.push(registerCustomMapHitTester(map, "landmarks", () => false));
    expect(getMapClickOwner(clickEvent())).toBeNull();
  });
});
