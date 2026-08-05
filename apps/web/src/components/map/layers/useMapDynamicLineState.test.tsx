import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CapturedConsoleErrors, captureConsoleErrors, createFakeMap } from "@/test";

const fake = createFakeMap({ styleLoaded: true });
/** Mutable so a test can null it the way `MapCanvas` does on teardown. */
const mapRef: { current: unknown } = { current: fake.map };

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));

import type { DynamicLineState } from "./useMapDynamicLineState";
import { useMapDynamicLineState } from "./useMapDynamicLineState";

function Probe({ paint, filters }: DynamicLineState) {
  useMapDynamicLineState({ paint, filters });
  return null;
}

function addLine(id = "line") {
  fake.map.addLayer({ id, type: "line", source: "src" } as never);
}

let errors: CapturedConsoleErrors | null = null;

afterEach(() => {
  errors?.restore();
  errors = null;
  mapRef.current = fake.map;
  fake.state.layers.clear();
  fake.state.paint.clear();
  fake.state.filters.clear();
  fake.state.sources.clear();
  fake.state.counts.setPaintProperty.clear();
  fake.state.counts.setPaintPropertyByName.clear();
  fake.state.counts.setFilter.clear();
  fake.state.counts.addLayer.clear();
  fake.state.counts.removeLayer.clear();
  fake.state.handlers.clear();
});

describe("useMapDynamicLineState", () => {
  it("applies paint and filter values once the layer exists", () => {
    addLine();

    render(
      <Probe
        paint={{ line: { "line-gradient": ["get", "a"] } }}
        filters={{ line: ["==", "a", 1] }}
      />,
    );

    expect(fake.state.paint.get("line")?.["line-gradient"]).toEqual(["get", "a"]);
    expect(fake.state.filters.get("line")).toEqual(["==", "a", 1]);
    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBe(1);
    expect(fake.state.counts.setFilter.get("line")).toBe(1);
  });

  it("does not call setPaintProperty or setFilter again when the value is unchanged on re-render", () => {
    addLine();
    const gradient = ["get", "a"];
    const filter = ["==", "a", 1];

    const { rerender } = render(
      <Probe paint={{ line: { "line-gradient": gradient } }} filters={{ line: filter }} />,
    );
    rerender(<Probe paint={{ line: { "line-gradient": gradient } }} filters={{ line: filter }} />);
    rerender(
      <Probe
        paint={{ line: { "line-gradient": [...gradient] } }}
        filters={{ line: [...filter] }}
      />,
    );

    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBe(1);
    expect(fake.state.counts.setFilter.get("line")).toBe(1);
  });

  it("applies exactly one call when the value changes", () => {
    addLine();

    const { rerender } = render(<Probe paint={{ line: { "line-gradient": ["get", "a"] } }} />);
    rerender(<Probe paint={{ line: { "line-gradient": ["get", "b"] } }} />);

    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBe(2);
    expect(fake.state.paint.get("line")?.["line-gradient"]).toEqual(["get", "b"]);
  });

  it("skips a layer that does not exist yet, without throwing, and applies once it appears", () => {
    // A throw here would fail the test on its own; no separate assertion needed.
    const { rerender } = render(<Probe paint={{ line: { "line-gradient": ["get", "a"] } }} />);
    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBeUndefined();

    addLine();
    rerender(<Probe paint={{ line: { "line-gradient": ["get", "a"] } }} />);

    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBe(1);
    expect(fake.state.paint.get("line")?.["line-gradient"]).toEqual(["get", "a"]);
  });

  it("reapplies the retained value immediately after a style rebuild that recreates the layer first in the same tick, even though the value never changed (cache invalidation)", () => {
    addLine();
    // Model `useMapLayerGroup`'s own `style.load` listener recreating the
    // layer synchronously — registered before the Probe mounts, so it runs
    // before this hook's own rebuild listener within the same `style.load`
    // emit, same as MapLibre firing listeners in registration order.
    fake.map.on("style.load", () => addLine());

    const gradient = ["get", "a"];
    render(<Probe paint={{ line: { "line-gradient": gradient } }} />);
    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBe(1);

    act(() => {
      fake.map.setStyle({} as never);
    });

    // The recreated layer carries no dynamic paint of its own; the fake
    // clears `state.paint` on `setStyle`, so a stale cache would wrongly
    // treat the unchanged gradient as "already applied" and never call
    // `setPaintProperty` again — but the layer object is new, so it does.
    expect(fake.state.paint.get("line")?.["line-gradient"]).toEqual(gradient);
    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBe(2);
  });

  it("lands the retained value via the microtask retry when the layer is recreated after the rebuild listeners run in the same tick", async () => {
    addLine();
    const gradient = ["get", "a"];
    render(<Probe paint={{ line: { "line-gradient": gradient } }} />);
    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBe(1);

    act(() => {
      fake.map.setStyle({} as never);
    });
    // Nothing recreated "line" during the style.load/styledata emit above, so
    // the immediate rebuild pass found no layer and skipped.
    expect(fake.state.layers.has("line")).toBe(false);

    act(() => {
      // Simulate the group's owning effect recreating the layer later in the
      // same tick, after both rebuild events already fired.
      addLine();
    });
    await act(async () => {});

    expect(fake.state.paint.get("line")?.["line-gradient"]).toEqual(gradient);
    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBe(2);
  });

  it("removes its listeners on unmount: emitting rebuild events afterward calls nothing and does not throw", () => {
    addLine();
    const { unmount } = render(<Probe paint={{ line: { "line-gradient": ["get", "a"] } }} />);
    const before = fake.state.counts.setPaintPropertyByName.get("line:line-gradient");

    unmount();

    expect(() => {
      fake.emit("style.load");
      fake.emit("styledata");
    }).not.toThrow();
    expect(fake.state.counts.setPaintPropertyByName.get("line:line-gradient")).toBe(before);
  });

  it("never creates or removes a source or a layer", () => {
    addLine();
    const gradient1 = ["get", "a"];
    const gradient2 = ["get", "b"];

    const { rerender, unmount } = render(
      <Probe paint={{ line: { "line-gradient": gradient1 } }} />,
    );
    rerender(<Probe paint={{ line: { "line-gradient": gradient2 } }} />);
    act(() => {
      fake.map.setStyle({} as never);
    });
    addLine();
    rerender(<Probe paint={{ line: { "line-gradient": gradient2 } }} />);
    unmount();

    // The only `addLayer` calls across this whole test came from this test's
    // own `addLine()` helper, never from the hook — and it never touches
    // sources at all (no `addSource` call site exists in the hook).
    expect(fake.state.counts.addLayer.get("line")).toBe(2);
    expect(fake.state.counts.removeLayer.get("line")).toBeUndefined();
    expect(fake.state.sources.size).toBe(0);
  });

  it("reports a thrown error via diagnostics without unmounting the tree, and clears it once fixed", () => {
    errors = captureConsoleErrors();
    addLine();
    const boom = new Proxy(
      { "line-gradient": ["get", "a"] },
      {
        get() {
          throw new Error("expression exploded");
        },
      },
    );

    expect(() => render(<Probe paint={{ line: boom as never }} />)).not.toThrow();
    expect(errors.count).toBeGreaterThan(0);
  });
});
