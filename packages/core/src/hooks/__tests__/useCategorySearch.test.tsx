import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { BoundingBox } from "../../types/geometry";
import { isAreaTooLarge, useCategorySearch } from "../useCategorySearch";

const bbox: BoundingBox = { south: 52.4, west: 13.3, north: 52.6, east: 13.5 };

describe("useCategorySearch", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches category results and forwards the bbox + lang", async () => {
    const response = { results: [{ id: "1" }], partial: false };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(response as never);

    const { result } = renderHook(() => useCategorySearch("restaurant", bbox, "en"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.categorySearch,
      {
        category: "restaurant",
        south: "52.4",
        west: "13.3",
        north: "52.6",
        east: "13.5",
        lang: "en",
      },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("omits lang when not supplied", async () => {
    const spy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ results: [], partial: false } as never);

    const { result } = renderHook(() => useCategorySearch("cafe", bbox), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.categorySearch,
      expect.not.objectContaining({ lang: expect.anything() }),
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("does not fire when category or bbox is missing", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(() => useCategorySearch(null, bbox), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("isAreaTooLarge detects the area_too_large error", () => {
    expect(isAreaTooLarge(new ApiClientError(422, { error: "area_too_large" }, null))).toBe(true);
    expect(isAreaTooLarge(new ApiClientError(422, { error: "other" }, null))).toBe(false);
    expect(isAreaTooLarge(new ApiClientError(500, null, null))).toBe(false);
    // Legacy message-shaped errors (non-client throwers) still resolve.
    expect(isAreaTooLarge(new Error("API error 413: area_too_large"))).toBe(true);
    expect(isAreaTooLarge(new Error("network failure"))).toBe(false);
    expect(isAreaTooLarge("not an error")).toBe(false);
  });
});
