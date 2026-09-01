import { useMemo } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MapContextValue } from "@/integration-api/map/MapContext";
import { createFakeMap, render } from "@/test";
import { useStyleSyncedLayer } from "./useStyleSyncedLayer";

function Harness({ mapContext, visible }: { mapContext: MapContextValue; visible: boolean }) {
  const addSource = useMemo(() => vi.fn(), []);
  const addLayer = useMemo(() => vi.fn(), []);
  useStyleSyncedLayer({
    map: mapContext,
    visible,
    sourceId: "test-source",
    layerId: "test-layer",
    addSource,
    addLayer,
    deps: [mapContext, visible],
  });
  return null;
}

describe("useStyleSyncedLayer lifecycle", () => {
  it("removes a delayed idle retry when the overlay unmounts", () => {
    const fake = createFakeMap({ styleLoaded: false });
    const mapRef = { current: fake.map };
    const mapContext = { mapRef, mapReady: true, styleVersion: 0 } as MapContextValue;
    const { unmount } = render(<Harness mapContext={mapContext} visible />);

    expect(fake.state.handlers.get("idle")?.size).toBe(1);
    unmount();
    expect(fake.state.handlers.get("idle")?.size).toBe(0);

    fake.state.styleLoaded = true;
    fake.emit("idle");
    expect(fake.state.sources.has("test-source")).toBe(false);
    expect(fake.state.layers.has("test-layer")).toBe(false);
  });
});
