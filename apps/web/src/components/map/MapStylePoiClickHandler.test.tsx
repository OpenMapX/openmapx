// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/map/MapContext", () => {
  const context = {
    mapRef: { current: null as unknown },
    mapReady: true,
    styleVersion: 0,
  };
  return { __test: context, useMap: () => context };
});
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));
const finePointer = { current: true };
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => finePointer.current }));
const usePlaceDetailsMock = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  usePlaceDetails: (...args: unknown[]) => usePlaceDetailsMock(...args),
  useSession: () => ({ data: null }),
  useIsSaved: () => ({ data: undefined }),
}));
vi.mock("@/components/auth/AuthDialog", () => ({ AuthDialog: () => null }));
vi.mock("@/components/panels/saved/SavePlaceDialog", () => ({ SavePlaceDialog: () => null }));

import { useCrowdReportStore } from "@integrations/crowd-reports/store";
import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import {
  createPlace,
  PANEL,
  useDirectionsStore,
  useMapClickStore,
  useNavigationStore,
  useParkingStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { fireEvent, screen } from "@testing-library/react";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import * as mapContext from "@/integration-api/map/MapContext";
import { MapClickHandler } from "./MapClickHandler";
import { MapStylePoiClickHandler } from "./MapStylePoiClickHandler";

const mapContextTest = (mapContext as unknown as { __test: { mapRef: { current: unknown } } })
  .__test;
const initialInteractiveLayerIds = new Set(INTERACTIVE_LAYER_IDS);

function pointFeature(
  properties: Record<string, unknown>,
  options: { id?: string | number; coordinates?: [number, number] } = {},
): MapGeoJSONFeature {
  return {
    type: "Feature",
    id: options.id,
    geometry: { type: "Point", coordinates: options.coordinates ?? [-77.02573, 38.88859] },
    properties,
    layer: { id: "poi-label", type: "symbol" },
    source: "openmaptiles",
    sourceLayer: "poi",
    state: {},
  } as unknown as MapGeoJSONFeature;
}

class FakeMap {
  readonly handlers = new Map<string, Set<(event: never) => void>>();
  readonly canvas = document.createElement("div");

  constructor(
    private featuresByLayer: Record<string, MapGeoJSONFeature[]>,
    private readonly styleLayers = [{ id: "poi-label", type: "symbol", "source-layer": "poi" }],
  ) {}

  getStyle = () => ({ layers: this.styleLayers });
  getLayer = (id: string) =>
    this.featuresByLayer[id] || this.styleLayers.some((layer) => layer.id === id)
      ? { id }
      : undefined;
  getCanvasContainer = () => this.canvas;
  getContainer = () => this.canvas;
  project = () => ({ x: 400, y: 200 });
  on = (event: string, handler: (event: never) => void) => {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  };
  off = (event: string, handler: (event: never) => void) => {
    this.handlers.get(event)?.delete(handler);
  };
  queryRenderedFeatures = (_point: unknown, options: { layers?: string[] }) =>
    options.layers?.flatMap((id) => this.featuresByLayer[id] ?? []) ?? [];
  setFeatures(featuresByLayer: Record<string, MapGeoJSONFeature[]>) {
    this.featuresByLayer = featuresByLayer;
  }
  addStyleLayer(layer: { id: string; type: string; "source-layer": string }) {
    this.styleLayers.push(layer);
  }
  emit(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload as never);
  }
}

function renderHandler(map: FakeMap) {
  mapContextTest.mapRef.current = map;
  return render(<MapStylePoiClickHandler />);
}

beforeEach(() => {
  useParkingStore.getState().reset();
  useCrowdReportStore.getState().stopPicking();
  useMeasurementStore.getState().deactivate();
  useTravelTimeStore.getState().deactivate();
  finePointer.current = true;
  usePlaceDetailsMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  INTERACTIVE_LAYER_IDS.clear();
});

afterEach(() => {
  useParkingStore.getState().reset();
  useCrowdReportStore.getState().stopPicking();
  useMeasurementStore.getState().deactivate();
  useTravelTimeStore.getState().deactivate();
  useNavigationStore.setState({ status: "idle" });
  useMapClickStore.getState().setClickedLngLat(null);
  mapContextTest.mapRef.current = null;
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  INTERACTIVE_LAYER_IDS.clear();
  for (const id of initialInteractiveLayerIds) INTERACTIVE_LAYER_IDS.add(id);
});

describe("MapStylePoiClickHandler", () => {
  it("allows ordinary POI selection while travel time is anchored", () => {
    const fake = new FakeMap({ "poi-label": [pointFeature({ name: "Museum" }, { id: 42 })] });
    useTravelTimeStore.getState().activateAnchored([8, 50]);
    renderHandler(fake);
    act(() =>
      fake.emit("click", {
        originalEvent: new MouseEvent("click"),
        point: { x: 12, y: 24 },
        lngLat: { lng: 8, lat: 50 },
      }),
    );
    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Museum");
    expect(useTravelTimeStore.getState().origin).toEqual([8, 50]);
  });
  it.each(["parking", "crowd", "measurement", "travel"])(
    "gives %s exclusive ownership regardless of listener order",
    (mode) => {
      for (const pickerFirst of [true, false]) {
        const fake = new FakeMap({ "poi-label": [pointFeature({ name: "Museum" }, { id: 42 })] });
        mapContextTest.mapRef.current = fake;
        const selected = createPlace({
          primaryScheme: "osm",
          ids: { osm: "node/1" },
          name: "Current place",
          address: "",
          coordinates: [8, 50],
        });
        usePlaceStore.getState().setSelectedPlace(selected);
        useSidebarStore.setState({
          activeSidebarId: PANEL.CATEGORY,
          activeDetailId: null,
          collapsed: false,
        });
        const view = render(
          pickerFirst ? (
            <>
              <MapClickHandler />
              <MapStylePoiClickHandler />
            </>
          ) : (
            <>
              <MapStylePoiClickHandler />
              <MapClickHandler />
            </>
          ),
        );
        act(() => {
          if (mode === "parking") useParkingStore.getState().setPicking(true);
          if (mode === "crowd") useCrowdReportStore.getState().startPicking();
          if (mode === "measurement") useMeasurementStore.getState().activate();
          if (mode === "travel") useTravelTimeStore.getState().activate();
          fake.emit("click", {
            point: { x: 12, y: 24 },
            lngLat: { lng: 8, lat: 50 },
            originalEvent: new MouseEvent("click"),
          });
        });
        expect(usePlaceStore.getState().selectedPlace).toBe(selected);
        expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
        expect(useSidebarStore.getState().activeDetailId).toBeNull();
        expect(useMapClickStore.getState().clickedLngLat).toBeNull();
        if (mode === "parking") expect(useParkingStore.getState().pickedCoords).toEqual([8, 50]);
        if (mode === "crowd") expect(useCrowdReportStore.getState().location).toEqual([8, 50]);
        view.unmount();
        useMeasurementStore.getState().deactivate();
        useTravelTimeStore.getState().deactivate();
      }
    },
  );
  it("selects a named style POI and opens the place sidebar", () => {
    const fake = new FakeMap({
      "poi-label": [
        pointFeature(
          { name: "Smithsonian Institution Building", class: "culture", subclass: "museum" },
          { id: 42 },
        ),
      ],
    });
    renderHandler(fake);

    act(() => {
      fake.emit("click", {
        point: { x: 12, y: 24 },
        lngLat: { lng: -77.02573, lat: 38.88859 },
      });
    });

    expect(usePlaceStore.getState().selectedPlace).toMatchObject({
      id: "stylePoi:42",
      name: "Smithsonian Institution Building",
      address: "Smithsonian Institution Building",
      coordinates: [-77.02573, 38.88859],
      category: "museum",
      rawCategory: "culture/museum",
    });
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
  });

  it("names the place the way the map labels it in the UI language", () => {
    const fake = new FakeMap({
      "poi-label": [
        pointFeature({ name: "Berliner Fernsehturm", "name:en": "Fernsehturm Berlin" }, { id: 7 }),
      ],
    });
    renderHandler(fake);

    act(() => fake.emit("click", { point: { x: 12, y: 24 } }));

    expect(usePlaceStore.getState().selectedPlace).toMatchObject({
      name: "Fernsehturm Berlin",
      ids: { stylePoi: "7" },
    });
  });

  it("preserves an active category sidebar and opens the place card", () => {
    const fake = new FakeMap({ "poi-label": [pointFeature({ name: "Smithsonian" })] });
    useSidebarStore.setState({ activeSidebarId: PANEL.CATEGORY });
    renderHandler(fake);

    act(() => fake.emit("click", { point: { x: 12, y: 24 } }));

    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
    expect(useSidebarStore.getState().activeDetailId).toBe(PANEL.PLACE_CARD);
  });

  it("does not select a POI when an interactive overlay is hit", () => {
    const fake = new FakeMap({
      "poi-label": [pointFeature({ name: "Smithsonian" })],
      "category-results-layer": [pointFeature({ name: "Result" })],
    });
    INTERACTIVE_LAYER_IDS.add("category-results-layer");
    renderHandler(fake);

    act(() => fake.emit("click", { point: { x: 12, y: 24 } }));

    expect(usePlaceStore.getState().selectedPlace).toBeNull();
  });

  it.each(["navigating", "rerouting", "arrived"] as const)(
    "neither selects a POI nor drops a pin while %s",
    (status) => {
      const fake = new FakeMap({ "poi-label": [pointFeature({ name: "Museum" }, { id: 42 })] });
      mapContextTest.mapRef.current = fake;
      useNavigationStore.setState({ status });
      const view = render(
        <>
          <MapClickHandler />
          <MapStylePoiClickHandler />
        </>,
      );
      const poiHit: Record<string, MapGeoJSONFeature[]> = {
        "poi-label": [pointFeature({ name: "Museum" })],
      };
      for (const features of [poiHit, {}]) {
        fake.setFeatures(features);
        act(() =>
          fake.emit("click", {
            point: { x: 12, y: 24 },
            lngLat: { lng: 8, lat: 50 },
            originalEvent: new MouseEvent("click"),
          }),
        );
      }
      expect(usePlaceStore.getState().selectedPlace).toBeNull();
      expect(useSidebarStore.getState().activeSidebarId).toBeNull();
      expect(useMapClickStore.getState().clickedLngLat).toBeNull();
      view.unmount();
    },
  );

  it("sets the pointer cursor only over a named POI", () => {
    const fake = new FakeMap({ "poi-label": [pointFeature({ name: "Smithsonian" })] });
    renderHandler(fake);

    const move = { point: { x: 12, y: 24 }, originalEvent: { buttons: 0 } };
    act(() => fake.emit("mousemove", move));
    expect(fake.canvas.style.cursor).toBe("pointer");

    fake.setFeatures({ "poi-label": [pointFeature({})] });
    act(() => fake.emit("mousemove", move));
    expect(fake.canvas.style.cursor).toBe("");
  });

  it("refreshes registered POI layer ids on styledata", () => {
    const fake = new FakeMap({}, []);
    renderHandler(fake);
    expect(INTERACTIVE_LAYER_IDS.has("poi-label")).toBe(false);

    fake.addStyleLayer({ id: "poi-label", type: "symbol", "source-layer": "poi" });
    act(() => fake.emit("styledata"));

    expect(INTERACTIVE_LAYER_IDS.has("poi-label")).toBe(true);
  });

  describe("hover card", () => {
    const POI = { name: "Smithsonian Institution Building", class: "culture", subclass: "museum" };
    const hover = (fake: FakeMap, buttons = 0) =>
      act(() => fake.emit("mousemove", { point: { x: 12, y: 24 }, originalEvent: { buttons } }));
    const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
    const lookedUpIds = () => usePlaceDetailsMock.mock.calls.map((call) => call[0]);

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("shows the card after a short rest and looks the place up only after a longer one", () => {
      const fake = new FakeMap({ "poi-label": [pointFeature(POI, { id: 42 })] });
      renderHandler(fake);

      hover(fake);
      advance(100);
      expect(screen.queryByTestId("poi-hover-card")).toBeNull();
      advance(30);
      expect(screen.getByTestId("poi-hover-card")).toHaveTextContent(POI.name);
      expect(lookedUpIds()).not.toContain("stylePoi:42");

      advance(200);
      // The very lookup a click makes, so the panel opens from its cache.
      expect(usePlaceDetailsMock).toHaveBeenLastCalledWith(
        "stylePoi:42",
        [-77.02573, 38.88859],
        POI.name,
        undefined,
        true,
      );
    });

    it("never shows or looks up a POI the pointer only passes over", () => {
      const fake = new FakeMap({ "poi-label": [pointFeature(POI, { id: 42 })] });
      renderHandler(fake);

      hover(fake);
      advance(60);
      fake.setFeatures({});
      hover(fake);
      advance(500);

      expect(screen.queryByTestId("poi-hover-card")).toBeNull();
      expect(lookedUpIds()).not.toContain("stylePoi:42");
    });

    it("stays open while the pointer crosses into the card and closes once it leaves", () => {
      const fake = new FakeMap({ "poi-label": [pointFeature(POI, { id: 42 })] });
      renderHandler(fake);
      hover(fake);
      advance(150);

      fake.setFeatures({});
      hover(fake);
      advance(50);
      fireEvent.pointerEnter(screen.getByTestId("poi-hover-card"));
      advance(500);
      expect(screen.getByTestId("poi-hover-card")).toBeInTheDocument();

      fireEvent.pointerLeave(screen.getByTestId("poi-hover-card"));
      advance(200);
      expect(screen.queryByTestId("poi-hover-card")).toBeNull();
    });

    it("closes at once when the map starts to move or a drag begins", () => {
      const fake = new FakeMap({ "poi-label": [pointFeature(POI, { id: 42 })] });
      renderHandler(fake);
      hover(fake);
      advance(150);

      act(() => fake.emit("movestart"));
      expect(screen.queryByTestId("poi-hover-card")).toBeNull();

      hover(fake, 1);
      advance(500);
      expect(screen.queryByTestId("poi-hover-card")).toBeNull();
    });

    it("switches straight to the next POI while a card is open", () => {
      const fake = new FakeMap({ "poi-label": [pointFeature(POI, { id: 42 })] });
      renderHandler(fake);
      hover(fake);
      advance(150);

      fake.setFeatures({ "poi-label": [pointFeature({ name: "Hirshhorn Museum" }, { id: 43 })] });
      hover(fake);

      expect(screen.getByTestId("poi-hover-card")).toHaveTextContent("Hirshhorn Museum");
    });

    it("opens the same place as a click, and directions from its button", () => {
      const fake = new FakeMap({ "poi-label": [pointFeature(POI, { id: 42 })] });
      renderHandler(fake);
      hover(fake);
      advance(150);

      fireEvent.click(screen.getByTestId("poi-hover-card"));
      expect(usePlaceStore.getState().selectedPlace).toMatchObject({ id: "stylePoi:42" });
      expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
      expect(screen.queryByTestId("poi-hover-card")).toBeNull();

      hover(fake);
      fake.setFeatures({});
      hover(fake);
      fake.setFeatures({ "poi-label": [pointFeature(POI, { id: 42 })] });
      hover(fake);
      advance(150);
      fireEvent.click(screen.getByRole("button", { name: "directions" }));
      const { waypoints, isOpen } = useDirectionsStore.getState();
      expect(isOpen).toBe(true);
      expect(waypoints.at(-1)).toMatchObject({ coords: [-77.02573, 38.88859], label: POI.name });
      expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.DIRECTIONS);
    });

    it("shows no card on a touch screen", () => {
      finePointer.current = false;
      const fake = new FakeMap({ "poi-label": [pointFeature(POI, { id: 42 })] });
      renderHandler(fake);
      hover(fake);
      advance(500);
      expect(screen.queryByTestId("poi-hover-card")).toBeNull();
      expect(fake.canvas.style.cursor).toBe("pointer");
    });
  });

  it("removes handlers and registered layer ids on unmount", () => {
    const fake = new FakeMap({ "poi-label": [pointFeature({ name: "Smithsonian" })] });
    const view = renderHandler(fake);
    expect(INTERACTIVE_LAYER_IDS.has("poi-label")).toBe(true);

    view.unmount();

    expect(INTERACTIVE_LAYER_IDS.has("poi-label")).toBe(false);
    expect([...fake.handlers.values()].every((handlers) => handlers.size === 0)).toBe(true);
  });
});
