import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CapturedConsoleErrors, captureConsoleErrors, createFakeMap } from "@/test";

const fake = createFakeMap({ styleLoaded: true });
/** Mutable so a test can null it the way `MapCanvas` does on teardown. */
const mapRef: { current: unknown } = { current: fake.map };

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion: 0 }),
}));

import { findMissingLayers } from "./desiredStack";
import { unregisterLayerSlot } from "./layerStack";
import type { MapLayerGroup } from "./mapLayerGroup";
import { useMapLayerGroup } from "./useMapLayerGroup";

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

function group(id: string, images?: MapLayerGroup["images"]): MapLayerGroup {
  return {
    ...(images ? { images } : {}),
    sources: { [`${id}-src`]: { type: "geojson", data: EMPTY_FC } as never },
    layers: [
      { id: `${id}-layer`, type: "circle", source: `${id}-src`, slot: "overlay-points" } as never,
    ],
  };
}

function Probe({ id, images }: { id: string; images?: MapLayerGroup["images"] }) {
  useMapLayerGroup(group(id, images));
  return null;
}

let errors: CapturedConsoleErrors | null = null;

afterEach(() => {
  errors?.restore();
  errors = null;
  mapRef.current = fake.map;
  unregisterLayerSlot("ok-layer");
  unregisterLayerSlot("bad-layer");
  unregisterLayerSlot("leak-layer");
});

describe("useMapLayerGroup lifecycle", () => {
  it("deregisters even when the map is already gone at unmount", () => {
    const { unmount } = render(<Probe id="leak" />);
    expect(findMissingLayers(fake.map)).toEqual([]);

    // `MapCanvas` nulls the shared ref in its own cleanup, and it is a sibling of
    // the layers — so it can run first and leave them unmounting with no map.
    mapRef.current = null;
    unmount();

    // A fresh map has none of the old sources. A stranded entry would surface
    // here as a layer wrongly reported missing, on every idle frame.
    const fresh = createFakeMap({ styleLoaded: true });
    expect(findMissingLayers(fresh.map)).toEqual([]);
  });

  it("keeps other groups drawing when one group's descriptor throws", () => {
    errors = captureConsoleErrors();
    const boom = () => {
      throw new Error("image load exploded");
    };

    expect(() =>
      render(
        <>
          <Probe id="bad" images={{ "bad-icon": boom }} />
          <Probe id="ok" />
        </>,
      ),
    ).not.toThrow();

    expect(fake.state.layers.has("ok-layer")).toBe(true);
    expect(fake.state.layers.has("bad-layer")).toBe(false);
    expect(errors.count).toBeGreaterThan(0);
  });

  it("reports a persistent fault once, not once per render", () => {
    errors = captureConsoleErrors();
    const boom = () => {
      throw new Error("image load exploded");
    };

    const { rerender } = render(<Probe id="bad" images={{ "bad-icon": boom }} />);
    rerender(<Probe id="bad" images={{ "bad-icon": boom }} />);
    rerender(<Probe id="bad" images={{ "bad-icon": boom }} />);

    // The apply runs on every render; an unchanged fault must not log on each one.
    expect(errors.count).toBe(1);
  });
});
