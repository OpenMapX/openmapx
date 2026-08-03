import { act, renderHook } from "@testing-library/react";
import type maplibregl from "maplibre-gl";
import type { MutableRefObject } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { type CapturedConsoleErrors, captureConsoleErrors, createFakeMap } from "@/test";
import { useGeoJsonSourceDataBridge } from "./useGeoJsonSourceDataBridge";

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

function point(lng: number) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: [lng, 50] },
      },
    ],
  };
}

function renderBridge(visible = true) {
  const fake = createFakeMap({ styleLoaded: true });
  const mapRef = { current: fake.map } as MutableRefObject<maplibregl.Map | null>;
  const hook = renderHook(
    ({ isVisible }) =>
      useGeoJsonSourceDataBridge({
        mapRef,
        mapReady: true,
        styleVersion: 0,
        visible: isVisible,
      }),
    { initialProps: { isVisible: visible } },
  );
  return { fake, ...hook };
}

describe("useGeoJsonSourceDataBridge", () => {
  let errors: CapturedConsoleErrors | undefined;

  afterEach(() => {
    errors?.restore();
    errors = undefined;
  });

  it("replays the latest payload after a real style replacement", async () => {
    const { fake, result } = renderBridge();
    fake.map.addSource("source", { type: "geojson", data: EMPTY_FC });
    act(() => {
      result.current.publish([{ sourceId: "source", data: point(10) }]);
    });
    fake.map.on("style.load", () => {
      fake.map.addSource("source", { type: "geojson", data: EMPTY_FC });
    });

    act(() => {
      fake.map.setStyle({} as never);
    });
    await act(async () => {});

    expect(fake.state.sources.get("source")?.data).toEqual(point(10));
  });

  it("clears an existing source while hidden without retaining the reset", () => {
    const { fake, result } = renderBridge(false);
    fake.map.addSource("source", { type: "geojson", data: point(1) });

    act(() => {
      result.current.reset([{ sourceId: "source", data: EMPTY_FC }]);
    });
    expect(fake.state.sources.get("source")?.data).toEqual(EMPTY_FC);

    fake.map.removeSource("source");
    fake.map.addSource("source", { type: "geojson", data: point(2) });
    act(() => fake.emit("styledata"));
    expect(fake.state.sources.get("source")?.data).toEqual(point(2));
  });

  it("supersedes the previous request and invalidates requests when hidden", () => {
    const { result, rerender } = renderBridge();
    const first = result.current.beginRequest();
    const second = result.current.beginRequest();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(first.isLatest()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(second.isLatest()).toBe(true);

    rerender({ isVisible: false });
    expect(second.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(false);
    expect(second.isLatest()).toBe(true);
  });

  it("invalidates the active request on unmount", () => {
    const { result, unmount } = renderBridge();
    const request = result.current.beginRequest();

    unmount();

    expect(request.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
    expect(request.isLatest()).toBe(false);
  });

  it("returns an already-aborted request while hidden", () => {
    const { result } = renderBridge(false);

    const request = result.current.beginRequest();

    expect(request.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
  });

  it("reports an incompatible source once and does not subscribe to sourcedata", () => {
    errors = captureConsoleErrors();
    const { fake, result } = renderBridge();
    fake.map.addSource("source", { type: "vector", tiles: [] });

    act(() => {
      result.current.publish([{ sourceId: "source", data: point(1) }]);
      result.current.apply();
    });

    expect(errors.count).toBe(1);
    expect(errors.calls).toEqual([
      ["GeoJSON data bridge cannot update incompatible MapLibre source(s): source (vector)"],
    ]);
    expect(fake.state.handlers.has("sourcedata")).toBe(false);
  });
});
