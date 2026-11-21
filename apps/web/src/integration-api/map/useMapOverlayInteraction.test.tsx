import { render } from "@testing-library/react";
import type { MapGeoJSONFeature, MapMouseEvent, Popup } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";

const fake = createFakeMap({ styleLoaded: true });

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true, styleVersion: 0 }),
}));

import { INTERACTIVE_LAYER_IDS } from "./interactiveLayers";
import { useMapOverlayInteraction, useMapOverlayPopup } from "./useMapOverlayInteraction";

function feature(layerId: string): MapGeoJSONFeature {
  return {
    type: "Feature",
    id: layerId,
    geometry: { type: "Point", coordinates: [8, 50] },
    properties: {},
    layer: { id: layerId, type: "circle" },
    source: "probe",
  } as unknown as MapGeoJSONFeature;
}

const pointer = { point: { x: 1, y: 2 }, lngLat: { lng: 8, lat: 50 } } as MapMouseEvent;

function addLayer(id: string) {
  fake.map.addSource(`${id}-src`, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  fake.map.addLayer({ id, type: "circle", source: `${id}-src` });
}

function Probe(props: {
  label: string;
  enabled?: boolean;
  onClick: (label: string) => void;
  onHover?: (features: MapGeoJSONFeature[] | null) => void;
}) {
  useMapOverlayInteraction({
    id: "probe",
    layerIds: ["probe-layer"],
    priority: 10,
    enabled: props.enabled,
    onClick: () => props.onClick(props.label),
    onHover: props.onHover,
  });
  return null;
}

afterEach(() => {
  for (const id of ["probe-layer"]) {
    if (fake.map.getLayer(id)) fake.map.removeLayer(id);
    if (fake.map.getSource(`${id}-src`)) fake.map.removeSource(`${id}-src`);
  }
  fake.setRenderedFeatures("probe-layer", []);
});

describe("useMapOverlayInteraction", () => {
  it("routes clicks and hover on its layers to the latest handlers", () => {
    addLayer("probe-layer");
    fake.setRenderedFeatures("probe-layer", [feature("probe-layer")]);
    const onClick = vi.fn();
    const onHover = vi.fn();
    const { rerender, unmount } = render(
      <Probe label="first" onClick={onClick} onHover={onHover} />,
    );
    expect(INTERACTIVE_LAYER_IDS.has("probe-layer")).toBe(true);

    rerender(<Probe label="second" onClick={onClick} onHover={onHover} />);
    fake.emit("click", pointer);
    expect(onClick).toHaveBeenCalledWith("second");

    fake.emit("mousemove", pointer);
    expect(
      (onHover.mock.calls.at(-1)?.[0] as MapGeoJSONFeature[] | undefined)?.map((hit) => hit.id),
    ).toEqual(["probe-layer"]);
    expect(fake.map.getCanvasContainer().style.cursor).toBe("pointer");

    fake.setRenderedFeatures("probe-layer", []);
    fake.emit("mousemove", pointer);
    expect(onHover).toHaveBeenLastCalledWith(null, pointer);
    expect(fake.map.getCanvasContainer().style.cursor).toBe("");

    unmount();
    expect(INTERACTIVE_LAYER_IDS.has("probe-layer")).toBe(false);
  });

  it("registers nothing while disabled", () => {
    addLayer("probe-layer");
    fake.setRenderedFeatures("probe-layer", [feature("probe-layer")]);
    const onClick = vi.fn();
    const { rerender, unmount } = render(<Probe label="x" enabled={false} onClick={onClick} />);
    fake.emit("click", pointer);
    expect(onClick).not.toHaveBeenCalled();
    expect(INTERACTIVE_LAYER_IDS.has("probe-layer")).toBe(false);

    rerender(<Probe label="x" enabled onClick={onClick} />);
    fake.emit("click", pointer);
    expect(onClick).toHaveBeenCalledTimes(1);
    unmount();
  });
});

function PopupProbe({ open, popup }: { open: boolean; popup: Popup }) {
  const { show } = useMapOverlayPopup(open);
  if (open) show(popup);
  return null;
}

describe("useMapOverlayPopup", () => {
  it("closes its popup when the overlay closes and when it unmounts", () => {
    const first = { addTo: vi.fn(), remove: vi.fn() } as unknown as Popup;
    const { rerender } = render(<PopupProbe open popup={first} />);
    expect(first.addTo).toHaveBeenCalledWith(fake.map);
    rerender(<PopupProbe open={false} popup={first} />);
    expect(first.remove).toHaveBeenCalledTimes(1);

    const second = { addTo: vi.fn(), remove: vi.fn() } as unknown as Popup;
    const { unmount } = render(<PopupProbe open popup={second} />);
    unmount();
    expect(second.remove).toHaveBeenCalledTimes(1);
  });
});
