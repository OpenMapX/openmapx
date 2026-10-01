import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper, createTestQueryClient } from "../../test/queryWrapper";
import { useAutocomplete } from "../useAutocomplete";

describe("useAutocomplete", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches suggestions for a query of length >= 2", async () => {
    const suggestions = [{ name: "Fulda", placeId: "p1" }];
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(suggestions as never);

    const queryClient = createTestQueryClient();
    const { result } = renderHook(() => useAutocomplete("Fu", "de"), {
      wrapper: createQueryWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(suggestions);
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.autocomplete,
      { q: "Fu", lang: "de" },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 8_000 }),
    );
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: ["autocomplete", "Fu", "de", undefined, undefined, undefined] })?.gcTime,
    ).toBe(120_000);
  });

  it("omits lang when not provided", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);

    const { result } = renderHook(() => useAutocomplete("Fu"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.autocomplete,
      { q: "Fu" },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 8_000 }),
    );
  });

  it("sends the location bias rounded to 2 dp with a floored zoom and keys on it", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);

    const queryClient = createTestQueryClient();
    const { result } = renderHook(
      () => useAutocomplete("coffee", "de", { proximity: [13.40471, 52.52049], zoom: 13.8 }),
      { wrapper: createQueryWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.autocomplete,
      { q: "coffee", lang: "de", lat: "52.52", lng: "13.40", zoom: "13" },
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(
      queryClient.getQueryCache().find({
        queryKey: ["autocomplete", "coffee", "de", "52.52", "13.40", "13"],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("sends the point without zoom when the bias has none", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);

    const { result } = renderHook(() => useAutocomplete("coffee", "de", { proximity: [2, 48] }), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.autocomplete,
      { q: "coffee", lang: "de", lat: "48.00", lng: "2.00" },
      expect.anything(),
    );
  });

  it("reuses prefix results as placeholder only at the same rounded location", async () => {
    const berlin = [{ id: "berlin-cafe", label: "Café", type: "poi" }];
    vi.spyOn(apiClient, "get").mockImplementation((_path, params) =>
      params?.q === "cof" ? Promise.resolve(berlin as never) : (new Promise(() => {}) as never),
    );
    const at = (lng: number, lat: number) => ({ proximity: [lng, lat] as [number, number] });

    const render = () =>
      renderHook(({ query, lng, lat }) => useAutocomplete(query, "de", at(lng, lat)), {
        initialProps: { query: "cof", lng: 13.4, lat: 52.52 },
        wrapper: createQueryWrapper(),
      });

    // Same ~1 km cell: the prefix continuation shows the previous suggestions.
    const same = render();
    await waitFor(() => expect(same.result.current.data).toEqual(berlin));
    same.rerender({ query: "coff", lng: 13.401, lat: 52.521 });
    expect(same.result.current.isPlaceholderData).toBe(true);
    expect(same.result.current.data).toEqual(berlin);
    same.unmount();

    // Map moved to Munich: nothing from Berlin may leak in.
    const moved = render();
    await waitFor(() => expect(moved.result.current.data).toEqual(berlin));
    moved.rerender({ query: "coff", lng: 11.58, lat: 48.14 });
    expect(moved.result.current.data).toBeUndefined();
    moved.unmount();
  });

  it("does not fire for a single-character query", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);

    const { result } = renderHook(() => useAutocomplete("F"), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("aborts the obsolete request when the search key changes", async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(apiClient, "get").mockImplementation((_path, _params, options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise(() => {}) as never;
    });
    const { rerender, unmount } = renderHook(({ query }) => useAutocomplete(query), {
      initialProps: { query: "Fu" },
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(signals).toHaveLength(1));

    rerender({ query: "Ful" });

    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    unmount();
  });
});
