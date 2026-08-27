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
      queryClient.getQueryCache().find({ queryKey: ["autocomplete", "Fu", "de"] })?.gcTime,
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
