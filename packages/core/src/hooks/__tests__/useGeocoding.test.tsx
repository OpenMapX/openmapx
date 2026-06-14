import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import { useGeocoding } from "../useGeocoding";

describe("useGeocoding", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches and returns search results for a query of length >= 3", async () => {
    const results = [{ name: "Berlin", coordinates: [13.4, 52.5] }];
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(results as never);

    const { result } = renderHook(() => useGeocoding("Berlin", "en"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(results);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.geocode, { q: "Berlin", lang: "en" });
  });

  it("omits lang from the request when not provided", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);

    const { result } = renderHook(() => useGeocoding("Berlin"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.geocode, { q: "Berlin" });
  });

  it("does not fire for a query shorter than 3 characters", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);

    const { result } = renderHook(() => useGeocoding("Be"), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only query as empty and stays idle", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);

    const { result } = renderHook(() => useGeocoding("   "), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
