import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper, createTestQueryClient } from "../../test/queryWrapper";
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
    expect(spy).toHaveBeenCalledWith(
      `${API_ENDPOINTS.places}/osm%3Away%2F1%20a`,
      { lat: "52.5", lng: "13.4", name: "Gate", lang: "en", hasAddress: "1" },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("sends an empty params object when only the id is provided", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ name: "x" } as never);

    const { result } = renderHook(() => usePlaceDetails("p1"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      `${API_ENDPOINTS.places}/p1`,
      {},
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("hides a Commons file icon in a persisted place query without refetching", async () => {
    const client = createTestQueryClient();
    client.setQueryData(
      ["place", { id: "p1", lng: null, lat: null, name: null, lang: null, hasAddress: false }],
      {
        name: "Aachen",
        photos: [
          {
            url: "https://commons.wikimedia.org/w/resources/assets/file-type-icons/fileicon-ogg.png",
          },
        ],
      },
    );
    const spy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ name: "Aachen", photos: [] } as never);

    const { result } = renderHook(() => usePlaceDetails("p1"), {
      wrapper: createQueryWrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.data?.photos).toEqual([]);
  });

  it("does not fire when the place id is null", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => usePlaceDetails(null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetches again when the same place id moves to different coordinates", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ name: "x" } as never);
    const { rerender } = renderHook(
      ({ point }: { point: LngLat }) => usePlaceDetails("custom-1", point, "Moving place"),
      {
        initialProps: { point: [13.4, 52.5] as LngLat },
        wrapper: createQueryWrapper(),
      },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    rerender({ point: [13.5, 52.6] });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[1]).toMatchObject({ lng: "13.5", lat: "52.6" });
  });
});
