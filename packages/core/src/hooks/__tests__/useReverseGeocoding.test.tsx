import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { LngLat } from "../../types/geometry";
import { useReverseGeocoding } from "../useReverseGeocoding";

const lngLat: LngLat = [13.4, 52.5];

describe("useReverseGeocoding", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches the reverse result with lat/lng query params", async () => {
    const place = { name: "Berlin" };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(place as never);

    const { result } = renderHook(() => useReverseGeocoding(lngLat, "en"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(place);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.geocodeReverse, {
      lat: "52.5",
      lng: "13.4",
      lang: "en",
    });
  });

  it("does not fire when coordinates are null", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(null as never);

    const { result } = renderHook(() => useReverseGeocoding(null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
