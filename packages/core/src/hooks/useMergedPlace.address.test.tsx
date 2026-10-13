import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataSourceStore } from "../stores/dataSourceStore";
import type { Place } from "../types/place";

const mocks = vi.hoisted(() => ({ details: vi.fn(), reverse: vi.fn() }));
vi.mock("./usePlaceDetails", () => ({ usePlaceDetails: mocks.details }));
vi.mock("./useReverseGeocoding", () => ({ useReverseGeocoding: mocks.reverse }));
vi.mock("./useDataSourceMatch", () => ({ useDataSourceMatch: () => null }));
vi.mock("./useOpeningHoursClock", () => ({ useOpeningHoursClock: () => Date.now() }));
const { useMergedPlace } = await import("./useMergedPlace");
const place = {
  id: "fuel:1",
  primaryScheme: "fuel",
  ids: { fuel: "1" },
  name: "Station",
  address: "Main St 1",
  city: "Town",
  coordinates: [6, 51],
  addressEvidence: {
    source: "fuel",
    method: "provider-address",
    recordId: "fuel:1",
    components: { full: "Main St 1", city: "Town" },
  },
} satisfies Place;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.details.mockReturnValue({ data: null, isLoading: false });
  mocks.reverse.mockReturnValue({ data: null });
  useDataSourceStore.setState({ selectedItem: { sourceId: "fuel", itemId: "1" } });
});

describe("address request and ownership behavior", () => {
  it("skips reverse for a resolved fixed provider address and city", () => {
    renderHook(() => useMergedPlace(place));
    expect(mocks.reverse).toHaveBeenCalledWith(null);
    expect(mocks.details.mock.calls[0][4]).toBe(true);
  });
  it("reuses cached resolver address and city before starting another reverse lookup", () => {
    const selected = { ...place, address: "", city: undefined, addressEvidence: undefined };
    mocks.details.mockReturnValue({
      data: {
        ...place,
        id: "osm:node/1",
        primaryScheme: "osm",
        ids: { osm: "node/1", fuel: "1" },
        addressEvidence: {
          source: "overpass",
          method: "osm-tags",
          recordId: "osm:node/1",
          components: { road: "Main St", house_number: "1" },
        },
      },
      isLoading: false,
    });
    renderHook(() => useMergedPlace(selected));
    expect(mocks.reverse).toHaveBeenCalledWith(null);
  });
  it("keeps reverse for missing fields, locality-only records, coordinates and vehicles", () => {
    for (const selected of [
      { ...place, city: undefined },
      { ...place, addressEvidence: { ...place.addressEvidence, components: { city: "Town" } } },
      { ...place, primaryScheme: "coordinate" },
      {
        ...place,
        ids: { fuel: "v:1" },
        id: "fuel:v:1",
        dataSourceDetail: {
          id: "v:1",
          name: "Station",
          sources: [],
          sections: [],
          coordinates: [6, 51] as [number, number],
        },
      },
    ]) {
      renderHook(() => useMergedPlace(selected));
      expect(mocks.reverse.mock.lastCall?.[0]).toEqual(place.coordinates);
    }
  });
  it("uses contextual reverse data for a moving vehicle's preview label", () => {
    const selected: Place = {
      ...place,
      id: "fuel:v:1",
      ids: { fuel: "v:1" },
      address: "Station",
      addressEvidence: undefined,
      dataSourceDetail: {
        id: "v:1",
        name: "Station",
        sources: [],
        sections: [],
        coordinates: [6, 51],
      },
    };
    mocks.reverse.mockReturnValue({
      data: {
        address: "Main St",
        city: "Town",
        addressEvidence: {
          source: "geocoding-nominatim",
          method: "reverse",
          components: { road: "Main St" },
        },
      },
    });
    const { result } = renderHook(() => useMergedPlace(selected));
    expect(result.current.place?.address).toBe("Main St");
    expect(result.current.place?.addressEvidence?.method).toBe("reverse");
    mocks.details.mockReturnValue({
      data: { ...selected, name: "", address: "" },
      isLoading: false,
    });
    const second = renderHook(() => useMergedPlace(selected));
    expect(second.result.current.place?.address).toBe("Main St");
  });
  it("lets reverse context fill a provider's locality-only display string", () => {
    const selected = {
      ...place,
      address: "Town",
      addressEvidence: { ...place.addressEvidence, components: { city: "Town" } },
    };
    mocks.details.mockReturnValue({ data: { ...selected, address: "" }, isLoading: false });
    mocks.reverse.mockReturnValue({
      data: {
        address: "Main St, Town",
        city: "Town",
        addressEvidence: {
          source: "geocoding-nominatim",
          method: "reverse",
          components: { road: "Main St", city: "Town" },
        },
      },
    });
    const { result } = renderHook(() => useMergedPlace(selected));
    expect(result.current.place?.address).toBe("Main St, Town");
    expect(result.current.place?.addressEvidence?.method).toBe("reverse");
  });
  it("rejects a conflicting resolver's city before reverse gap-filling", () => {
    const selected: Place = {
      ...place,
      ids: { fuel: "1", osm: "way/1" },
      address: "Locality",
      city: undefined,
      addressEvidence: {
        source: "fuel",
        method: "provider-address",
        components: { city: "Locality" },
      },
    };
    mocks.details.mockReturnValue({
      data: {
        ...selected,
        ids: { osm: "way/2" },
        address: "Wrong St",
        city: "WrongTown",
        fieldContributors: { city: [{ sourceId: "wrong", name: "Wrong source" }] },
      },
      isLoading: false,
    });
    mocks.reverse.mockReturnValue({
      data: {
        address: "Right St, RightTown",
        city: "RightTown",
        addressEvidence: {
          source: "reverse",
          method: "reverse",
          components: { road: "Right St", city: "RightTown" },
        },
        contributors: [{ sourceId: "reverse", name: "Reverse" }],
      },
    });
    const { result } = renderHook(() => useMergedPlace(selected));
    expect(result.current.place?.address).toBe("Right St, RightTown");
    expect(result.current.place?.city).toBe("RightTown");
    expect(result.current.place?.fieldContributors?.city).toEqual([
      { sourceId: "reverse", name: "Reverse" },
    ]);
  });
  it("keeps address evidence and attribution attached to the chosen explicit address", () => {
    useDataSourceStore.setState({ selectedItem: null });
    const selected: Place = {
      ...place,
      id: "osm:way/1",
      primaryScheme: "osm",
      ids: { osm: "way/1" },
      address: "Grunerstraße 20",
      addressEvidence: {
        source: "overpass",
        method: "osm-tags",
        recordId: "osm:way/1",
        components: { road: "Grunerstraße", house_number: "20" },
      },
      fieldContributors: { address: [{ sourceId: "overpass", name: "OSM" }] },
    };
    mocks.details.mockReturnValue({
      data: {
        ...selected,
        address: "Alexanderstraße",
        addressEvidence: {
          source: "geocoding-nominatim",
          method: "provider-address",
          recordId: "osm:way/1",
          components: { road: "Alexanderstraße" },
        },
      },
      isLoading: false,
    });
    const { result } = renderHook(() => useMergedPlace(selected));
    expect(result.current.place?.address).toBe("Grunerstraße 20");
    expect(result.current.place?.addressEvidence).toEqual(selected.addressEvidence);
    expect(result.current.place?.fieldContributors?.address).toEqual(
      selected.fieldContributors?.address,
    );
  });
  it("requests exact direct OSM details and retains the selected primary ID", () => {
    useDataSourceStore.setState({ selectedItem: null });
    const selected: Place = {
      ...place,
      id: "maptiler:poi.1",
      primaryScheme: "maptiler",
      ids: { maptiler: "poi.1", osm: "way/1" },
      directOsmReference: {
        source: "geocoding-maptiler",
        recordId: "maptiler:poi.1",
        osmRef: "way/1",
      },
    };
    mocks.details.mockReturnValue({
      data: { ...place, id: "osm:way/1", primaryScheme: "osm", ids: { osm: "way/1" } },
      isLoading: false,
    });
    const { result } = renderHook(() => useMergedPlace(selected));
    expect(mocks.details.mock.calls[0][0]).toBe("osm:way/1");
    expect(result.current.place?.id).toBe("maptiler:poi.1");
    expect(result.current.place?.ids).toEqual(selected.ids);
    expect(result.current.place?.directOsmReference).toEqual(selected.directOsmReference);
  });
});
