import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { LngLat } from "../../types/geometry";
import { usePlaceDetails } from "../usePlaceDetails";

const coordinates: LngLat = [13.4, 52.5];

describe("usePlaceDetails", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches the place by URL-encoded id and forwards optional params", async () => {
    const place = { name: "Brandenburg Gate" };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(place as never);

    const { result } = renderHook(
      () => usePlaceDetails("osm:way/1 a", coordinates, "Gate", "en", true),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(place);
    expect(spy).toHaveBeenCalledWith(`${API_ENDPOINTS.places}/osm%3Away%2F1%20a`, {
      lat: "52.5",
      lng: "13.4",
      name: "Gate",
      lang: "en",
      hasAddress: "1",
    });
  });

  it("sends an empty params object when only the id is provided", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ name: "x" } as never);

    const { result } = renderHook(() => usePlaceDetails("p1"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(`${API_ENDPOINTS.places}/p1`, {});
  });

  it("does not fire when the place id is null", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => usePlaceDetails(null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
