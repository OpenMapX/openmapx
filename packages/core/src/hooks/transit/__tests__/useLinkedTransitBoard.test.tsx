import type { TransitStop } from "@openmapx/mobility-core/transit";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../../api/client";
import { createQueryWrapper } from "../../../test/queryWrapper";
import { makeSyntheticStopPlace } from "../../../utils/geocodeStopAsPlace";
import { useLinkedTransitArrivals } from "../useLinkedTransitArrivals";
import { useLinkedTransitDepartures } from "../useLinkedTransitDepartures";

const stop: TransitStop = {
  id: "ms:breslauer",
  provider: "ms",
  name: "Köln Breslauer Platz/Hbf",
  lat: 50.944,
  lng: 6.96,
  modes: ["bus"],
};

describe.each([
  ["departures", useLinkedTransitDepartures],
  ["arrivals", useLinkedTransitArrivals],
] as const)("place %s board", (kind, useBoard) => {
  beforeEach(() => vi.restoreAllMocks());

  it("names the stop the place was opened for, so the board treats it as main", async () => {
    const spy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: [], attributions: [] } as never);
    const place = { ...makeSyntheticStopPlace(stop), name: "Breslauer Platz" };
    const { result } = renderHook(() => useBoard(place, 30), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      `/api/integrations/transit/${kind}/for-place`,
      expect.objectContaining({ name: "Breslauer Platz", stop_name: "Köln Breslauer Platz/Hbf" }),
    );
  });

  it("sends the place's OSM object, whose local name links its stops", async () => {
    const spy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: [], attributions: [] } as never);
    const place = { ...makeSyntheticStopPlace(stop), ids: { ms: "breslauer", osm: "node/42" } };
    const { result } = renderHook(() => useBoard(place, 30), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy.mock.calls[0][1]).toMatchObject({ osm_id: "node/42" });
  });

  it("sends no stop for a place not opened for one", async () => {
    const spy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: [], attributions: [] } as never);
    const { transitStop: _, ...place } = makeSyntheticStopPlace(stop);
    const { result } = renderHook(() => useBoard(place, 30), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy.mock.calls[0][1]).not.toHaveProperty("stop_name");
  });
});
