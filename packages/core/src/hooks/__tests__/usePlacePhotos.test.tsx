import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper, createTestQueryClient } from "../../test/queryWrapper";
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
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.photos,
      { lat: "52.5", lng: "13.4", name: "Cafe", placeId: "p1", limit: "5" },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("sends only lat/lng when no options are provided", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ photos: [] } as never);

    const { result } = renderHook(() => usePlacePhotos(52.5, 13.4), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.photos,
      { lat: "52.5", lng: "13.4" },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("hides a Commons file icon in a persisted gallery query without refetching", async () => {
    const client = createTestQueryClient();
    client.setQueryData(["placePhotos", 52.5, 13.4, undefined, undefined, undefined], {
      photos: [
        {
          url: "https://commons.wikimedia.org/w/resources/assets/file-type-icons/fileicon-ogg.png",
        },
      ],
    });
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ photos: [] } as never);

    const { result } = renderHook(() => usePlacePhotos(52.5, 13.4), {
      wrapper: createQueryWrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
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
