import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, apiClient } from "../../../api/client";
import { API_ENDPOINTS } from "../../../api/endpoints";
import { createQueryWrapper } from "../../../test/queryWrapper";
import { useTransitStops } from "../useTransitStops";

const bbox = { west: 13.3, south: 52.4, east: 13.5, north: 52.6 };
const envelope = { data: [], attributions: [], freshness: undefined };

// Match the web provider's retry count. The shared test wrapper defaults to
// retry:false, which would hide an extra oversized-area request.
function productionQueryWrapper() {
  return createQueryWrapper(
    new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000, retry: 1, gcTime: 60 * 60_000 } },
    }),
  );
}

describe("useTransitStops recovery", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("surfaces an oversized-area error after one request", async () => {
    const get = vi
      .spyOn(apiClient, "get")
      .mockRejectedValue(new ApiClientError(422, { error: "area_too_large" }, null));

    const { result } = renderHook(() => useTransitStops(bbox), {
      wrapper: productionQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3_000 });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      API_ENDPOINTS.transitStops,
      { sw_lat: "52.4", sw_lng: "13.3", ne_lat: "52.6", ne_lng: "13.5" },
      expect.anything(),
    );
  });

  it("keeps one automatic retry for ordinary errors and allows manual retry", async () => {
    const get = vi
      .spyOn(apiClient, "get")
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(envelope as never);

    const { result } = renderHook(() => useTransitStops(bbox), {
      wrapper: productionQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3_000 });
    expect(get).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(get).toHaveBeenCalledTimes(3);
  });
});
