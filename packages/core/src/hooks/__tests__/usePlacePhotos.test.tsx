import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import { usePlacePhotos } from "../usePlacePhotos";

describe("usePlacePhotos", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("selects the photos array out of the response and forwards optional params", async () => {
    const photos = [{ url: "https://example.com/a.jpg" }];
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ photos } as never);

    const { result } = renderHook(
      () => usePlacePhotos(52.5, 13.4, { name: "Cafe", placeId: "p1", limit: 5 }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(photos);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.photos, {
      lat: "52.5",
      lng: "13.4",
      name: "Cafe",
      placeId: "p1",
      limit: "5",
    });
  });

  it("sends only lat/lng when no options are provided", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ photos: [] } as never);

    const { result } = renderHook(() => usePlacePhotos(52.5, 13.4), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.photos, { lat: "52.5", lng: "13.4" });
  });

  it("does not fire when coordinates are missing", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ photos: [] } as never);

    const { result } = renderHook(() => usePlacePhotos(undefined, 13.4), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fire when explicitly disabled", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ photos: [] } as never);

    const { result } = renderHook(() => usePlacePhotos(52.5, 13.4, { enabled: false }), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
