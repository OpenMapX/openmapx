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
