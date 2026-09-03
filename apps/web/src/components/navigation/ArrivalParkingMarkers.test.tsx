// @vitest-environment jsdom

import type { CategoryPlace } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@/test";

const { createdMarkers, FakeMarker } = vi.hoisted(() => {
  const markers: FakeMarkerInstance[] = [];
  interface FakeMarkerInstance {
    options: { element: HTMLElement };
    lngLat: [number, number] | null;
    map: { container: HTMLElement } | null;
    remove: ReturnType<typeof vi.fn>;
    setLngLat: (coords: [number, number]) => FakeMarkerInstance;
    addTo: (map: { container: HTMLElement }) => FakeMarkerInstance;
  }

  class FakeMarker implements FakeMarkerInstance {
    options: { element: HTMLElement };
    lngLat: [number, number] | null = null;
    map: { container: HTMLElement } | null = null;

    constructor(options: { element: HTMLElement }) {
      this.options = options;
      markers.push(this);
    }

    setLngLat(coords: [number, number]) {
      this.lngLat = coords;
      return this;
    }

    addTo(map: { container: HTMLElement }) {
      this.map = map;
      map.container.append(this.options.element);
      return this;
    }

    remove = vi.fn(() => {
      this.options.element.remove();
    });
  }

  return { createdMarkers: markers, FakeMarker };
});

vi.mock("maplibre-gl", () => {
  return {
    default: { Marker: FakeMarker },
    Marker: FakeMarker,
  };
});

const mockMapContext = vi.hoisted(() => ({
  current: null as {
    mapRef?: { current: { container: HTMLElement } | null };
    getMap?: () => { container: HTMLElement } | null;
  } | null,
}));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMapOptional: () => mockMapContext.current,
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { ArrivalParkingMarkers } from "./ArrivalParkingMarkers";

const samplePlaces: CategoryPlace[] = [
  {
    id: "p1",
    name: "Parking Central",
    coordinates: [13.405, 52.52],
    category: "parking",
  },
  {
    id: "p2",
    name: "Underground Garage",
    coordinates: [13.408, 52.522],
    category: "parking",
  },
];

describe("ArrivalParkingMarkers", () => {
  let mapContainer: HTMLElement;

  beforeEach(() => {
    createdMarkers.length = 0;
    mapContainer = document.createElement("div");
    mockMapContext.current = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders without crashing when map context is null", () => {
    const { container } = render(
      <ArrivalParkingMarkers places={[]} selectedPlace={null} onSelectPlace={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing into the React DOM container even with places and map", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };
    const { container } = render(
      <ArrivalParkingMarkers places={samplePlaces} selectedPlace={null} onSelectPlace={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("adds markers to the map container via mapRef.current", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };

    render(
      <ArrivalParkingMarkers places={samplePlaces} selectedPlace={null} onSelectPlace={vi.fn()} />,
    );

    const markers = mapContainer.querySelectorAll(".omx-arrival-parking-marker");
    expect(markers).toHaveLength(2);
    expect(markers[0].textContent).toBe("P");
    expect(markers[1].textContent).toBe("P");
    expect(createdMarkers).toHaveLength(2);
    expect(createdMarkers[0].lngLat).toEqual([13.405, 52.52]);
    expect(createdMarkers[1].lngLat).toEqual([13.408, 52.522]);
  });

  it("renders no markers when the map is not ready yet", () => {
    mockMapContext.current = {
      mapRef: { current: null },
    };

    render(
      <ArrivalParkingMarkers places={samplePlaces} selectedPlace={null} onSelectPlace={vi.fn()} />,
    );

    const markers = mapContainer.querySelectorAll(".omx-arrival-parking-marker");
    expect(markers).toHaveLength(0);
  });

  it("highlights the selected marker with active styles", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };

    render(
      <ArrivalParkingMarkers
        places={samplePlaces}
        selectedPlace={samplePlaces[0]}
        onSelectPlace={vi.fn()}
      />,
    );

    const markers = mapContainer.querySelectorAll<HTMLElement>(".omx-arrival-parking-marker");
    expect(markers).toHaveLength(2);

    // Selected marker: background #1A73E8, color #ffffff
    expect(markers[0].style.backgroundColor).toBe("rgb(26, 115, 232)");
    expect(markers[0].style.color).toBe("rgb(255, 255, 255)");
    expect(markers[0].style.border).toBe("2px solid rgb(26, 115, 232)");

    // Unselected marker: background #ffffff, color #1A73E8
    expect(markers[1].style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(markers[1].style.color).toBe("rgb(26, 115, 232)");
    expect(markers[1].style.border).toBe("2px solid rgb(26, 115, 232)");
  });

  it("calls onSelectPlace with place when clicking an unselected marker", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };
    const onSelectPlace = vi.fn();

    render(
      <ArrivalParkingMarkers
        places={samplePlaces}
        selectedPlace={null}
        onSelectPlace={onSelectPlace}
      />,
    );

    const markers = mapContainer.querySelectorAll<HTMLElement>(".omx-arrival-parking-marker");
    fireEvent.click(markers[0]);

    expect(onSelectPlace).toHaveBeenCalledTimes(1);
    expect(onSelectPlace).toHaveBeenCalledWith(samplePlaces[0]);
  });

  it("disables marker interaction while a handoff is starting", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };
    const onSelectPlace = vi.fn();

    render(
      <ArrivalParkingMarkers
        places={samplePlaces}
        selectedPlace={null}
        onSelectPlace={onSelectPlace}
        disabled
      />,
    );

    const marker = mapContainer.querySelector<HTMLElement>(".omx-arrival-parking-marker");
    expect(marker).not.toBeNull();
    expect(marker).toHaveAttribute("aria-disabled", "true");
    expect(marker).toHaveAttribute("tabindex", "-1");
    fireEvent.click(marker as HTMLElement);
    fireEvent.keyDown(marker as HTMLElement, { key: "Enter" });
    expect(onSelectPlace).not.toHaveBeenCalled();
  });

  it("calls onSelectPlace with null when clicking an already selected marker (toggle)", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };
    const onSelectPlace = vi.fn();

    render(
      <ArrivalParkingMarkers
        places={samplePlaces}
        selectedPlace={samplePlaces[0]}
        onSelectPlace={onSelectPlace}
      />,
    );

    const markers = mapContainer.querySelectorAll<HTMLElement>(".omx-arrival-parking-marker");
    fireEvent.click(markers[0]);

    expect(onSelectPlace).toHaveBeenCalledTimes(1);
    expect(onSelectPlace).toHaveBeenCalledWith(null);
  });

  it("handles keyboard events (Enter and Space) on markers", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };
    const onSelectPlace = vi.fn();

    render(
      <ArrivalParkingMarkers
        places={samplePlaces}
        selectedPlace={samplePlaces[1]}
        onSelectPlace={onSelectPlace}
      />,
    );

    const markers = mapContainer.querySelectorAll<HTMLElement>(".omx-arrival-parking-marker");

    // Enter on unselected
    fireEvent.keyDown(markers[0], { key: "Enter" });
    expect(onSelectPlace).toHaveBeenLastCalledWith(samplePlaces[0]);

    // Space on selected
    fireEvent.keyDown(markers[1], { key: " " });
    expect(onSelectPlace).toHaveBeenLastCalledWith(null);
  });

  it("cleans up markers on unmount", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };

    const { unmount } = render(
      <ArrivalParkingMarkers places={samplePlaces} selectedPlace={null} onSelectPlace={vi.fn()} />,
    );

    expect(mapContainer.querySelectorAll(".omx-arrival-parking-marker")).toHaveLength(2);

    unmount();

    expect(mapContainer.querySelectorAll(".omx-arrival-parking-marker")).toHaveLength(0);
    for (const marker of createdMarkers) {
      expect(marker.remove).toHaveBeenCalled();
    }
  });

  it("updates markers when places or selectedPlace change", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };

    const { rerender } = render(
      <ArrivalParkingMarkers
        places={[samplePlaces[0]]}
        selectedPlace={null}
        onSelectPlace={vi.fn()}
      />,
    );

    expect(mapContainer.querySelectorAll(".omx-arrival-parking-marker")).toHaveLength(1);

    rerender(
      <ArrivalParkingMarkers
        places={samplePlaces}
        selectedPlace={samplePlaces[1]}
        onSelectPlace={vi.fn()}
      />,
    );

    const markers = mapContainer.querySelectorAll<HTMLElement>(".omx-arrival-parking-marker");
    expect(markers).toHaveLength(2);
    expect(markers[1].style.backgroundColor).toBe("rgb(26, 115, 232)");
  });

  it("skips places that violate the canonical coordinates contract", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };

    const mixedPlaces = [
      {
        id: "loc1",
        name: "Location Object Place",
        location: { lng: 13.5, lat: 52.6 },
      } as unknown as CategoryPlace,
      {
        id: "loc2",
        name: "Missing Coords Place",
      } as unknown as CategoryPlace,
    ];

    render(
      <ArrivalParkingMarkers places={mixedPlaces} selectedPlace={null} onSelectPlace={vi.fn()} />,
    );

    const markers = mapContainer.querySelectorAll(".omx-arrival-parking-marker");
    expect(markers).toHaveLength(0);
    expect(createdMarkers).toHaveLength(0);
  });

  it("uses navigation.nearbyParking as aria-label fallback for unnamed place", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };

    const unnamedPlace: CategoryPlace = {
      id: "unnamed1",
      name: "",
      coordinates: [13.4, 52.5],
    };

    render(
      <ArrivalParkingMarkers
        places={[unnamedPlace]}
        selectedPlace={null}
        onSelectPlace={vi.fn()}
      />,
    );

    const markerEl = mapContainer.querySelector<HTMLElement>(".omx-arrival-parking-marker");
    expect(markerEl?.getAttribute("aria-label")).toBe("navigation.nearbyParking");
  });
});
