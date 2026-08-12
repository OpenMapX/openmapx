import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { createQueryWrapper } from "../test/queryWrapper";
import { useSearchSuggestions } from "./useSearchSuggestions";

describe("useSearchSuggestions", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends locale and rounded map proximity", async () => {
    const response = { suggestions: [], attributions: [], partial: false };
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(response as never);

    const { result } = renderHook(() => useSearchSuggestions("UNCC", "en", [-80.734, 35.307], 8), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith(API_ENDPOINTS.searchSuggestions, {
      q: "UNCC",
      lang: "en",
      lng: "-80.73",
      lat: "35.31",
      limit: "8",
    });
  });

  it("shares cached results across equivalent normalized queries", async () => {
    const response = { suggestions: [], attributions: [], partial: false };
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(response as never);
    const { rerender, result } = renderHook(
      ({ query }) => useSearchSuggestions(query, "en", null, 8),
      { initialProps: { query: "UNCC" }, wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ query: "  uncc  " });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not request fewer than two normalized letters or digits", () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => useSearchSuggestions(" - ", "de", null, 8), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(get).not.toHaveBeenCalled();
  });
});
