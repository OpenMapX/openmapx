import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api/client";
import { createQueryWrapper, createTestQueryClient } from "../test/queryWrapper";
import { useAirQuality, useAirQualityForecast } from "./useAirQuality";

describe("air-quality hooks", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([
    [null, 13.4, true],
    [52.5, null, true],
    [52.5, 13.4, false],
  ])("does not request current evidence without enabled coordinates", (lat, lng, enabled) => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);
    const { result } = renderHook(() => useAirQuality(lat, lng, { enabled }), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(get).not.toHaveBeenCalled();
  });

  it("requests current evidence with hints, comparison, cancellation, and a five-minute stale time", async () => {
    const response = { status: "ok", evidence: [] };
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(response as never);
    const client = createTestQueryClient();
    const { result } = renderHook(
      () =>
        useAirQuality(52.5, 13.4, {
          countryCode: "DE",
          subdivisionCode: "DE-BE",
          comparisonStandard: "us-epa-2024",
        }),
      { wrapper: createQueryWrapper(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    expect(get).toHaveBeenCalledWith(
      "/api/integrations/air-quality/current",
      {
        lat: "52.5",
        lng: "13.4",
        countryCode: "DE",
        subdivisionCode: "DE-BE",
        comparisonStandard: "us-epa-2024",
      },
      { signal: expect.any(AbortSignal) },
    );
    const query = client.getQueryCache().find({
      queryKey: ["air-quality", "current", 52.5, 13.4, "DE", "DE-BE", "us-epa-2024"],
    });
    expect((query?.options as { staleTime?: number } | undefined)?.staleTime).toBe(5 * 60 * 1_000);
  });

  it("makes comparison part of the current query identity", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ status: "ok" } as never);
    const { rerender } = renderHook(
      ({ comparisonStandard }) =>
        useAirQuality(52.5, 13.4, {
          comparisonStandard,
        }),
      {
        initialProps: { comparisonStandard: undefined as "us-epa-2024" | undefined },
        wrapper: createQueryWrapper(),
      },
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    rerender({ comparisonStandard: "us-epa-2024" });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("loads a 48-hour forecast only after its disclosure is enabled", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ status: "ok" } as never);
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useAirQualityForecast(52.5, 13.4, {
          enabled,
          countryCode: "DE",
          subdivisionCode: "DE-BE",
          comparisonStandard: "us-epa-2024",
        }),
      { initialProps: { enabled: false }, wrapper: createQueryWrapper() },
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(get).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith(
      "/api/integrations/air-quality/forecast",
      {
        lat: "52.5",
        lng: "13.4",
        hours: "48",
        countryCode: "DE",
        subdivisionCode: "DE-BE",
        comparisonStandard: "us-epa-2024",
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("forwards TanStack cancellation to the API client", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(apiClient, "get").mockImplementation((_path, _query, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    });
    const { unmount } = renderHook(() => useAirQuality(52.5, 13.4), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("surfaces request errors", async () => {
    const error = new Error("offline");
    vi.spyOn(apiClient, "get").mockRejectedValue(error);
    const { result } = renderHook(() => useAirQuality(52.5, 13.4), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(error);
  });
});
