import type { MapGeoJSONFeature, Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import {
  type MapOverlayInteractionEvent,
  registerMapOverlayInteraction,
  removeMapOverlayPopup,
  replaceMapOverlayPopup,
} from "./mapInteractionArbiter";

type Handler = (...args: unknown[]) => void;

function createMap() {
  const handlers = new Map<string, Set<Handler>>();
  const existingLayers = new Set<string>();
  const hits = new Map<string, MapGeoJSONFeature[]>();
  const canvas = { style: { cursor: "" } };
  const map = {
    on(event: string, handler: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
      return map;
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
      return map;
    },
    getLayer(id: string) {
      return existingLayers.has(id) ? { id } : undefined;
    },
    queryRenderedFeatures(_point: unknown, options?: { layers?: string[] }) {
      return (options?.layers ?? []).flatMap((id) => hits.get(id) ?? []);
    },
    getCanvasContainer() {
      return canvas;
    },
    emit(event: string, payload?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    addLayer(id: string) {
      existingLayers.add(id);
    },
    setHits(id: string, features: MapGeoJSONFeature[]) {
      hits.set(id, features);
    },
    handlerCount(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
  return { map: map as unknown as MaplibreMap, state: map };
}

function feature(id: string): MapGeoJSONFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [6.77, 51.2] },
    properties: { id },
    layer: { id, type: "circle" },
    source: "test",
    sourceLayer: undefined,
    state: {},
  } as unknown as MapGeoJSONFeature;
}

function event(): MapMouseEvent {
  return {
    point: { x: 10, y: 20 },
    lngLat: { lng: 6.77, lat: 51.2 },
  } as unknown as MapMouseEvent;
}

describe("map interaction arbiter", () => {
  beforeEach(() => {
    INTERACTIVE_LAYER_IDS.delete("test-incident");
    INTERACTIVE_LAYER_IDS.delete("test-flow");
  });

  it("dispatches one click to the highest-priority overlay with a hit", () => {
    const { map, state } = createMap();
    state.addLayer("test-incident");
    state.addLayer("test-flow");
    state.setHits("test-incident", [feature("incident")]);
    state.setHits("test-flow", [feature("flow")]);
    const incident = vi.fn();
    const flow = vi.fn();

    const unregisterFlow = registerMapOverlayInteraction(map, {
      id: "flow",
      layerIds: ["test-flow"],
      priority: 10,
      onClick: flow,
    });
    const unregisterIncident = registerMapOverlayInteraction(map, {
      id: "incident",
      layerIds: ["test-incident"],
      priority: 20,
      onClick: incident,
    });

    state.emit("click", event());
    expect(incident).toHaveBeenCalledTimes(1);
    expect(flow).not.toHaveBeenCalled();
    const firstCall = incident.mock.calls[0]?.[0] as MapOverlayInteractionEvent | undefined;
    expect(firstCall?.features).toEqual([feature("incident")]);

    unregisterIncident();
    state.emit("click", event());
    expect(flow).toHaveBeenCalledTimes(1);

    unregisterFlow();
    expect(state.handlerCount("click")).toBe(0);
    expect(INTERACTIVE_LAYER_IDS.has("test-incident")).toBe(false);
    expect(INTERACTIVE_LAYER_IDS.has("test-flow")).toBe(false);
  });

  it("arbitrates the shared pointer cursor and clears it on map leave", () => {
    const { map, state } = createMap();
    state.addLayer("test-flow");
    const unregister = registerMapOverlayInteraction(map, {
      id: "flow",
      layerIds: ["test-flow"],
      priority: 10,
      onClick: vi.fn(),
    });

    state.setHits("test-flow", [feature("flow")]);
    state.emit("mousemove", event());
    expect(state.getCanvasContainer().style.cursor).toBe("pointer");

    state.setHits("test-flow", []);
    state.emit("mousemove", event());
    expect(state.getCanvasContainer().style.cursor).toBe("");

    state.setHits("test-flow", [feature("flow")]);
    state.emit("mousemove", event());
    state.emit("mouseout", {});
    expect(state.getCanvasContainer().style.cursor).toBe("");

    unregister();
  });

  it("replaces only the currently owned popup", () => {
    const { map } = createMap();
    const first = { addTo: vi.fn(), remove: vi.fn() };
    const second = { addTo: vi.fn(), remove: vi.fn() };

    replaceMapOverlayPopup(map, first as never);
    replaceMapOverlayPopup(map, second as never);
    expect(first.remove).toHaveBeenCalledTimes(1);
    expect(second.addTo).toHaveBeenCalledWith(map);

    removeMapOverlayPopup(map, first as never);
    expect(second.remove).not.toHaveBeenCalled();
    removeMapOverlayPopup(map, second as never);
    expect(second.remove).toHaveBeenCalledTimes(1);
  });
});
