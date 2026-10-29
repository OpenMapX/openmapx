import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, renderHook } from "@/test";
import { useMapAttributionStore } from "./mapAttributionStore";
import { useMapAttributions } from "./useMapAttributions";
import { useRenderedMapAttributions } from "./useRenderedMapAttributions";

const { mapRef } = vi.hoisted(() => ({ mapRef: { current: null as unknown } }));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));
const credit = (name: string) => ({ sourceId: name, name });
const html = () =>
  Object.values(useMapAttributionStore.getState().byLayer)
    .flat()
    .map((entry) => entry.fullHtml)
    .join(" ");

beforeEach(() => useMapAttributionStore.setState({ byLayer: {} }));

describe("independent attribution owners", () => {
  it("keeps both instances' credits when they reuse a readable layer key", () => {
    const first = renderHook(
      ({ active }) => useMapAttributions("traffic", active ? [credit("first")] : []),
      {
        initialProps: { active: true },
      },
    );
    const second = renderHook(() => useMapAttributions("traffic", [credit("second")]));
    expect(html()).toContain("first");
    expect(html()).toContain("second");
    first.rerender({ active: false });
    expect(html()).not.toContain("first");
    expect(html()).toContain("second");
    first.unmount();
    expect(html()).toContain("second");
    second.unmount();
    expect(html()).toBe("");
  });

  it("does not let a disabled instance clear an already registered instance", () => {
    renderHook(() => useMapAttributions("same", [credit("owed")]));
    const disabled = renderHook(() => useMapAttributions("same", []));
    expect(html()).toContain("owed");
    disabled.unmount();
    expect(html()).toContain("owed");
  });

  it("isolates rendered owners and batches their shared viewport query", () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeMap();
      mapRef.current = fake.map;
      fake.map.addLayer({ id: "receipt", type: "circle", source: "data" });
      fake.setRenderedFeatures("receipt", [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [6, 51] },
          properties: { _mapAttributions: JSON.stringify([credit("visible")]) },
        },
      ] as never);
      const query = vi.spyOn(fake.map, "queryRenderedFeatures");
      const layers = ["receipt"];
      const first = renderHook(
        ({ active }) => useRenderedMapAttributions("shared", layers, active),
        { initialProps: { active: true } },
      );
      const second = renderHook(() => useRenderedMapAttributions("shared", layers, true));
      act(() => {
        fake.emit("render");
        vi.advanceTimersByTime(250);
      });
      expect(html()).toContain("visible");
      expect(query).toHaveBeenCalledTimes(1);
      first.rerender({ active: false });
      expect(html()).toContain("visible");
      second.unmount();
      expect(html()).toBe("");
      first.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
