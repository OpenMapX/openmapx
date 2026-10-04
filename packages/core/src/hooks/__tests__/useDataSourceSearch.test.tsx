import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { BoundingBox } from "../../types/geometry";
import { useDataSourceSearch, useDataSources } from "../useDataSources";

const bbox: BoundingBox = { south: 52.4, west: 13.3, north: 52.6, east: 13.5 };
const freshness = { fetchedAt: "2026-10-04T10:00:00.000Z", hasRealtimeData: false, isStale: false };

describe("useDataSourceSearch", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  it.each(["area", "unavailable"] as const)("says why the answer is partial (%s)", async (why) => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      data: [],
      attributions: [],
      freshness,
      partial: why,
    } as never);

    const { result } = renderHook(() => useDataSourceSearch("fuel", bbox, {}), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.partial).toBe(why);
    expect(result.current.data).toEqual([]);
  });

  it("is not partial when the answer does not say so", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      data: [],
      attributions: [],
      freshness,
    } as never);

    const { result } = renderHook(() => useDataSourceSearch("fuel", bbox, {}), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.partial).toBeNull();
  });

  it("asks a partial answer again every 5 s, at most three times", async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({
      data: [],
      attributions: [],
      freshness,
      partial: "area",
    } as never);

    renderHook(() => useDataSourceSearch("fuel", bbox, {}), { wrapper: createQueryWrapper() });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(get).toHaveBeenCalledTimes(1);

    for (const calls of [2, 3, 4]) {
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(get).toHaveBeenCalledTimes(calls);
    }
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("stops asking once the answer is complete", async () => {
    vi.useFakeTimers();
    const get = vi
      .spyOn(apiClient, "get")
      .mockResolvedValueOnce({ data: [], attributions: [], freshness, partial: "area" } as never)
      .mockResolvedValue({ data: [], attributions: [], freshness } as never);

    const { result } = renderHook(() => useDataSourceSearch("fuel", bbox, {}), {
      wrapper: createQueryWrapper(),
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.partial).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("useDataSources", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  it("asks for the list again when it is used after five minutes", async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ sources: [] } as never);
    // Kept between mounts, as the app's client keeps it.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mount = async () => {
      const view = renderHook(() => useDataSources(), { wrapper: createQueryWrapper(client) });
      await act(() => vi.advanceTimersByTimeAsync(0));
      view.unmount();
    };

    await mount();
    expect(get).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
    await mount();
    expect(get).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(60_000 + 1));
    await mount();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
