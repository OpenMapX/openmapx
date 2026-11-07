// @vitest-environment jsdom

import type { CategoryPlace } from "@openmapx/core";
import { useParkingStore } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
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

const receipts = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/integration-api/overlay/renderedMapAttributionTracker", () => ({
  renderedMapAttributionTracker: () => ({ subscribe: receipts.subscribe }),
}));

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
    useParkingStore.getState().reset();
    createdMarkers.length = 0;
    receipts.subscribe.mockReset().mockReturnValue(receipts.unsubscribe);
    mapContainer = document.createElement("div");
    mockMapContext.current = null;
  });

  afterEach(() => {
    useParkingStore.getState().reset();
    vi.clearAllMocks();
  });

  it("registers only painted coordinate receipts and withdraws them with removed markers", () => {
    document.body.append(mapContainer);
    const bounds = () =>
      ({ left: 10, top: 10, right: 100, bottom: 100, width: 90, height: 90 }) as DOMRect;
    mapContainer.getBoundingClientRect = bounds;
    const map = { container: mapContainer, getContainer: () => mapContainer };
    mockMapContext.current = { mapRef: { current: map } };
    const coordinate = { sourceId: "coords", name: "Parking coordinates" };
    const hidden = { sourceId: "name", name: "Hidden name" };
    const place = {
      ...samplePlaces[0],
      contributors: [hidden],
      fieldContributors: { coordinates: [coordinate], name: [hidden] },
    };
    const { unmount } = render(
      <ArrivalParkingMarkers places={[place]} selectedPlace={null} onSelectPlace={vi.fn()} />,
    );
    const marker = mapContainer.querySelector<HTMLElement>(".omx-arrival-parking-marker");
    if (!marker) throw new Error("Expected a painted arrival marker");
    marker.getBoundingClientRect = bounds;
    const subscription = receipts.subscribe.mock.calls.at(-1)?.[1] as
      | { resolveCustomContributors: () => unknown }
      | undefined;
    expect(subscription?.resolveCustomContributors()).toEqual([coordinate]);
    marker.style.display = "none";
    expect(subscription?.resolveCustomContributors()).toEqual([]);
    marker.style.display = "flex";
    unmount();
    expect(receipts.unsubscribe).toHaveBeenCalled();
    expect(subscription?.resolveCustomContributors()).toEqual([]);
    mapContainer.remove();
  });

  it("credits the router that measured a marker's walk with its coordinates", () => {
    document.body.append(mapContainer);
    const bounds = () =>
      ({ left: 10, top: 10, right: 100, bottom: 100, width: 90, height: 90 }) as DOMRect;
    mapContainer.getBoundingClientRect = bounds;
    const map = { container: mapContainer, getContainer: () => mapContainer };
    mockMapContext.current = { mapRef: { current: map } };
    const coordinate = { sourceId: "osm-parking", name: "OpenStreetMap" };
    const router = { sourceId: "valhalla", name: "Valhalla" };
    render(
      <ArrivalParkingMarkers
        places={[
          {
            ...samplePlaces[0],
            contributors: [coordinate],
            walk: { seconds: 120, meters: 150, contributors: [router] },
          },
        ]}
        selectedPlace={null}
        onSelectPlace={vi.fn()}
      />,
    );
    const marker = mapContainer.querySelector<HTMLElement>(".omx-arrival-parking-marker");
    if (!marker) throw new Error("Expected a painted arrival marker");
    marker.getBoundingClientRect = bounds;
    const subscription = receipts.subscribe.mock.calls.at(-1)?.[1] as
      | { resolveCustomContributors: () => unknown }
      | undefined;
    expect(subscription?.resolveCustomContributors()).toEqual([coordinate, router]);
    mapContainer.remove();
  });

  it("suppresses an arrival marker pointer while picking and keeps keyboard activation", () => {
    mockMapContext.current = { mapRef: { current: { container: mapContainer } } };
    const onSelectPlace = vi.fn();
    render(
      <ArrivalParkingMarkers
        places={samplePlaces}
        selectedPlace={null}
        onSelectPlace={onSelectPlace}
      />,
    );
    const marker = mapContainer.querySelector<HTMLElement>(".omx-arrival-parking-marker");
    useParkingStore.getState().setPicking(true);
    fireEvent.click(marker as HTMLElement);
    expect(onSelectPlace).not.toHaveBeenCalled();
    fireEvent.keyDown(marker as HTMLElement, { key: "Enter" });
    expect(onSelectPlace).toHaveBeenCalledWith(samplePlaces[0]);
  });

  it("claims clicks from the map, even while disabled", () => {
    mockMapContext.current = { mapRef: { current: { container: mapContainer } } };
    const mapClickOwners: unknown[] = [];
    const mapClick = (event: Event) => mapClickOwners.push(getMapClickOwner(event));
    mapContainer.addEventListener("click", mapClick);
    const onSelectPlace = vi.fn();
    const { rerender } = render(
      <ArrivalParkingMarkers
        places={samplePlaces}
        selectedPlace={null}
        onSelectPlace={onSelectPlace}
      />,
    );
    fireEvent.click(mapContainer.querySelector(".omx-arrival-parking-marker") as HTMLElement);
    expect(onSelectPlace).toHaveBeenCalledWith(samplePlaces[0]);
    rerender(
      <ArrivalParkingMarkers
        places={samplePlaces}
        selectedPlace={samplePlaces[0]}
        onSelectPlace={onSelectPlace}
      />,
    );
    fireEvent.click(mapContainer.querySelector(".omx-arrival-parking-marker") as HTMLElement);
    expect(onSelectPlace).toHaveBeenLastCalledWith(null);
    expect(onSelectPlace).toHaveBeenCalledTimes(2);

    rerender(
      <ArrivalParkingMarkers
        places={samplePlaces}
        selectedPlace={null}
        onSelectPlace={onSelectPlace}
        disabled
      />,
    );
    fireEvent.click(mapContainer.querySelector(".omx-arrival-parking-marker") as HTMLElement);
    expect(onSelectPlace).toHaveBeenCalledTimes(2);
    expect(mapClickOwners).toEqual(["marker", "marker", "marker"]);
    mapContainer.removeEventListener("click", mapClick);
  });

  it.each([
    { label: "no map context", value: null },
    { label: "no ready map", value: { mapRef: { current: null } } },
  ])("creates no marker resources with $label", ({ value }) => {
    mockMapContext.current = value;
    render(
      <ArrivalParkingMarkers places={samplePlaces} selectedPlace={null} onSelectPlace={vi.fn()} />,
    );
    expect(createdMarkers).toHaveLength(0);
    expect(receipts.subscribe).not.toHaveBeenCalled();
    expect(mapContainer.querySelectorAll(".omx-arrival-parking-marker")).toHaveLength(0);
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

    expect(markers[0]).toHaveAttribute("aria-pressed", "true");
    expect(markers[1]).toHaveAttribute("aria-pressed", "false");
    expect(markers[0].style.backgroundColor).toBe(markers[1].style.color);
    expect(markers[0].style.color).toBe(markers[1].style.backgroundColor);
    expect(markers[0].style.backgroundColor).not.toBe(markers[1].style.backgroundColor);
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

  it("updates markers when places or selectedPlace change", () => {
    mockMapContext.current = {
      mapRef: { current: { container: mapContainer } },
    };

    const { rerender, unmount } = render(
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
    expect(markers[1]).toHaveAttribute("aria-pressed", "true");
    expect(markers[1].style.backgroundColor).not.toBe(markers[0].style.backgroundColor);
    expect([...markers].map((marker) => marker.textContent)).toEqual(["P", "P"]);
    expect(createdMarkers.slice(-2).map((marker) => marker.lngLat)).toEqual([
      [13.405, 52.52],
      [13.408, 52.522],
    ]);
    unmount();
    expect(mapContainer.querySelectorAll(".omx-arrival-parking-marker")).toHaveLength(0);
    for (const marker of createdMarkers) expect(marker.remove).toHaveBeenCalled();
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
