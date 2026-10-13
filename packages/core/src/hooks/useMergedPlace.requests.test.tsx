import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { buildPlaceDetailsRequest } from "../api/placeDetails";
import { useDataSourceStore } from "../stores/dataSourceStore";
import { createQueryWrapper, createTestQueryClient } from "../test/queryWrapper";
import type { Place } from "../types/place";
import { useMergedPlace } from "./useMergedPlace";

vi.mock("./useDataSourceMatch", () => ({ useDataSourceMatch: () => null }));
vi.mock("./useOpeningHoursClock", () => ({ useOpeningHoursClock: () => Date.now() }));

const selected: Place = {
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
    components: { full: "Main St 1", city: "Town" },
  },
};
beforeEach(() => useDataSourceStore.setState({ selectedItem: { sourceId: "fuel", itemId: "1" } }));
afterEach(() => {
  vi.restoreAllMocks();
  useDataSourceStore.getState().clearSelection();
});

it("makes only the detail request for a resolved fixed data-source place", async () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue(selected as never);
  const client = createTestQueryClient();
  const view = renderHook(() => useMergedPlace(selected), { wrapper: createQueryWrapper(client) });
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0][0]).toBe(`${API_ENDPOINTS.places}/fuel%3A1`);
  expect(view.result.current.place?.address).toBe("Main St 1");
  view.unmount();
  client.clear();
});

it("makes no requests when cached details already resolve the missing address", () => {
  const incomplete: Place = {
    ...selected,
    address: "",
    city: undefined,
    addressEvidence: undefined,
  };
  const client = createTestQueryClient();
  const request = buildPlaceDetailsRequest({
    id: incomplete.id,
    coordinates: incomplete.coordinates,
    name: incomplete.name,
    hasAddress: false,
  });
  client.setQueryData(["place", request.identity], {
    ...selected,
    id: "osm:node/1",
    primaryScheme: "osm",
    ids: { osm: "node/1", fuel: "1" },
    addressEvidence: {
      source: "overpass",
      method: "osm-tags",
      recordId: "osm:node/1",
      components: { road: "Main St", house_number: "1" },
    },
  });
  const get = vi.spyOn(apiClient, "get").mockResolvedValue(null as never);
  const view = renderHook(() => useMergedPlace(incomplete), {
    wrapper: createQueryWrapper(client),
  });
  expect(get).not.toHaveBeenCalled();
  expect(view.result.current.place?.address).toBe("Main St 1");
  view.unmount();
  client.clear();
});

it("still reverse-geocodes coordinate selections once", async () => {
  useDataSourceStore.getState().clearSelection();
  const get = vi
    .spyOn(apiClient, "get")
    .mockResolvedValue({ address: "Main St", city: "Town" } as never);
  const client = createTestQueryClient();
  const point: Place = {
    ...selected,
    id: "coordinate:51-6",
    primaryScheme: "coordinate",
    ids: { coordinate: "51-6" },
    address: "",
    city: undefined,
    addressEvidence: undefined,
  };
  const view = renderHook(() => useMergedPlace(point), { wrapper: createQueryWrapper(client) });
  await waitFor(() => expect(view.result.current.place?.address).toBe("Main St"));
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0][0]).toBe(API_ENDPOINTS.geocodeReverse);
  view.unmount();
  client.clear();
});

it("does not snap elsewhere when the directly referenced OSM object is unavailable", async () => {
  useDataSourceStore.getState().clearSelection();
  const get = vi.spyOn(apiClient, "get").mockRejectedValue(new Error("No exact OSM object"));
  const client = createTestQueryClient();
  const maptiler: Place = {
    ...selected,
    id: "maptiler:poi.1",
    primaryScheme: "maptiler",
    ids: { maptiler: "poi.1", osm: "way/1" },
    directOsmReference: {
      source: "geocoding-maptiler",
      recordId: "maptiler:poi.1",
      osmRef: "way/1",
    },
  };
  const view = renderHook(() => useMergedPlace(maptiler), { wrapper: createQueryWrapper(client) });
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0][0]).toBe(`${API_ENDPOINTS.places}/osm%3Away%2F1`);
  expect(view.result.current.place?.id).toBe("maptiler:poi.1");
  expect(view.result.current.place?.address).toBe(selected.address);
  view.unmount();
  client.clear();
});
