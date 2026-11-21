// @vitest-environment jsdom

import type { LngLat } from "@openmapx/core";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeMarkerShape {
  element: HTMLElement;
  anchor?: string;
  lngLat: [number, number];
  removed: boolean;
  handlers: Map<string, Array<() => void>>;
  fire(type: string): void;
}

const fake = vi.hoisted(() => ({ markers: [] as FakeMarkerShape[] }));

vi.mock("@/integration-api/map/MapContext", () => {
  const value = { mapReady: true, mapRef: { current: null as { container: HTMLElement } | null } };
  return { __test: value, useMap: () => value };
});

vi.mock("maplibre-gl", () => {
  class FakeMarker {
    element: HTMLElement;
    anchor?: string;
    lngLat: [number, number] = [0, 0];
    removed = false;
    handlers = new Map<string, Array<() => void>>();
    constructor(options: { element: HTMLElement; anchor?: string }) {
      this.element = options.element;
      this.anchor = options.anchor;
      fake.markers.push(this);
    }
    setLngLat(ll: [number, number]) {
      this.lngLat = [ll[0], ll[1]];
      return this;
    }
    getLngLat() {
      return { lng: this.lngLat[0], lat: this.lngLat[1] };
    }
    addTo(map: { container: HTMLElement }) {
      map.container.append(this.element);
      return this;
    }
    on(type: string, fn: () => void) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
      return this;
    }
    fire(type: string) {
      for (const fn of this.handlers.get(type) ?? []) fn();
    }
    remove() {
      this.removed = true;
      this.element.remove();
      return this;
    }
  }
  return { Marker: FakeMarker };
});

import { useDirectionsStore } from "@openmapx/core";
import * as mapContext from "@/integration-api/map/MapContext";
import { WaypointMarkers } from "./WaypointMarkers";

const mapContextTest = (
  mapContext as unknown as { __test: { mapRef: { current: { container: HTMLElement } | null } } }
).__test;

const A: LngLat = [6.1, 51.1];
const B: LngLat = [6.2, 51.2];
const C: LngLat = [6.3, 51.3];
const D: LngLat = [6.4, 51.4];
const DROP: LngLat = [7.7, 52.7];

function setUp(points: Array<[LngLat, string]>) {
  const s = useDirectionsStore.getState();
  s.close();
  s.open();
  const first = points[0];
  const last = points.at(-1);
  assert(first && last, "a start and an end waypoint");
  s.setWaypoint(0, first[0], first[1]);
  s.setWaypoint(1, last[0], last[1]);
  points.slice(1, -1).forEach(([coords, label], k) => {
    useDirectionsStore.getState().insertWaypoint(k + 1, coords, label);
  });
  return useDirectionsStore.getState().waypoints.map((wp) => wp.id);
}

const live = () => fake.markers.filter((m) => !m.removed);

const markerAt = (c: LngLat) => {
  const found = live().filter((m) => m.lngLat[0] === c[0] && m.lngLat[1] === c[1]);
  expect(found).toHaveLength(1);
  const [marker] = found;
  assert.isDefined(marker);
  return marker;
};

const byId = (id: string) => useDirectionsStore.getState().waypoints.find((w) => w.id === id);

function drag(marker: FakeMarkerShape, to: LngLat) {
  act(() => {
    marker.fire("dragstart");
    marker.lngLat = [to[0], to[1]];
    marker.fire("dragend");
  });
}

beforeEach(() => {
  mapContextTest.mapRef.current = { container: document.createElement("div") };
  fake.markers.length = 0;
});

afterEach(() => {
  cleanup();
  useDirectionsStore.getState().close();
});

describe("WaypointMarkers", () => {
  it("moves the dragged waypoint and swaps pin styles after a reverse", async () => {
    const [a, b, c] = setUp([
      [A, "A"],
      [B, "B"],
      [C, "C"],
    ]);
    render(<WaypointMarkers />);
    await waitFor(() => expect(live()).toHaveLength(3));

    act(() => useDirectionsStore.getState().reverseWaypoints());
    await waitFor(() => {
      expect(markerAt(A).element.querySelector("svg")).not.toBeNull();
      expect(markerAt(A).anchor).toBe("bottom");
    });
    expect(markerAt(C).element.querySelector("svg")).toBeNull();

    drag(markerAt(C), DROP);
    expect(byId(c)?.coords).toEqual(DROP);
    expect(byId(c)?.label).toBe("C");
    expect(byId(a)?.coords).toEqual(A);
    expect(byId(a)?.label).toBe("A");
    expect(byId(b)?.coords).toEqual(B);
  });

  it("moves the dragged waypoint after a stop is inserted before it", async () => {
    const [, c] = setUp([
      [A, "A"],
      [C, "C"],
    ]);
    render(<WaypointMarkers />);
    await waitFor(() => expect(live()).toHaveLength(2));

    act(() => {
      useDirectionsStore.getState().insertWaypoint(1, B, "B");
    });
    await waitFor(() => expect(live()).toHaveLength(3));
    const b = useDirectionsStore.getState().waypoints[1]?.id;

    drag(markerAt(C), DROP);
    expect(byId(c)?.coords).toEqual(DROP);
    expect(byId(b)?.coords).toEqual(B);
    expect(byId(b)?.label).toBe("B");
    expect(markerAt(B).element.textContent).toBe("1");
  });

  it("moves the dragged waypoint and renumbers stops after a removal", async () => {
    const [, , c, d] = setUp([
      [A, "A"],
      [B, "B"],
      [C, "C"],
      [D, "D"],
    ]);
    render(<WaypointMarkers />);
    await waitFor(() => expect(live()).toHaveLength(4));

    act(() => useDirectionsStore.getState().removeWaypoint(1));
    await waitFor(() => expect(live()).toHaveLength(3));
    await waitFor(() => expect(markerAt(C).element.textContent).toBe("1"));

    drag(markerAt(D), DROP);
    expect(byId(d)?.coords).toEqual(DROP);
    expect(byId(c)?.coords).toEqual(C);
  });

  it("moves the dragged waypoint and restyles pins after a reorder", async () => {
    const [a, b] = setUp([
      [A, "A"],
      [B, "B"],
      [C, "C"],
    ]);
    render(<WaypointMarkers />);
    await waitFor(() => expect(live()).toHaveLength(3));

    act(() => useDirectionsStore.getState().reorderWaypoints(0, 2));
    await waitFor(() => {
      expect(markerAt(B).element.querySelector("svg")).toBeNull();
      expect(markerAt(B).element.textContent).toBe("");
      expect(markerAt(A).anchor).toBe("bottom");
    });

    drag(markerAt(A), DROP);
    expect(byId(a)?.coords).toEqual(DROP);
    expect(byId(b)?.coords).toEqual(B);
  });

  it("keeps a marker that is being dragged across a reverse", async () => {
    const [a, , c] = setUp([
      [A, "A"],
      [B, "B"],
      [C, "C"],
    ]);
    render(<WaypointMarkers />);
    await waitFor(() => expect(live()).toHaveLength(3));

    const m = markerAt(C);
    act(() => m.fire("dragstart"));
    act(() => useDirectionsStore.getState().reverseWaypoints());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(m.removed).toBe(false);

    act(() => {
      m.lngLat = [DROP[0], DROP[1]];
      m.fire("dragend");
    });
    expect(byId(c)?.coords).toEqual(DROP);
    expect(byId(a)?.coords).toEqual(A);
    await waitFor(() => {
      const rebuilt = markerAt(DROP);
      expect(rebuilt.element.querySelector("svg")).toBeNull();
      expect(rebuilt.anchor).toBe("center");
    });
  });

  it("moves the existing marker when only the coordinates change", async () => {
    setUp([
      [A, "A"],
      [C, "C"],
    ]);
    render(<WaypointMarkers />);
    await waitFor(() => expect(live()).toHaveLength(2));

    const m = markerAt(A);
    act(() => useDirectionsStore.getState().setWaypoint(0, B, "B"));
    await waitFor(() => expect(m.lngLat).toEqual(B));
    expect(fake.markers).toHaveLength(2);
  });
});
