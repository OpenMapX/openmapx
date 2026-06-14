import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../../api/client";
import { API_ENDPOINTS } from "../../../api/endpoints";
import { createQueryWrapper } from "../../../test/queryWrapper";
import type { LngLat } from "../../../types/geometry";
import { useStopsNearby } from "../useStopsNearby";

const location: LngLat = [13.4, 52.5];

describe("useStopsNearby", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches nearby stops and unwraps the envelope", async () => {
    const envelope = {
      data: [{ id: "ms:s1", name: "Alexanderplatz" }],
      attributions: [{ name: "MOTIS" }],
      freshness: undefined,
    };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(envelope as never);

    const { result } = renderHook(() => useStopsNearby(location, 800, ["bus", "tram"]), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(envelope.data);
    expect(result.current.attributions).toEqual(envelope.attributions);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.transitStopsNearby, {
      lat: "52.5",
      lng: "13.4",
      radius: "800",
      modes: "bus,tram",
    });
  });

  it("defaults the radius to 500 and omits modes when none are given", async () => {
    const spy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: [], attributions: [] } as never);

    const { result } = renderHook(() => useStopsNearby(location), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.transitStopsNearby, {
      lat: "52.5",
      lng: "13.4",
      radius: "500",
    });
  });

  it("does not fire when the location is null", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => useStopsNearby(null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.attributions).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
