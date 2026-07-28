import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { BoundingBox } from "../../types/geometry";
import { useNlpSearch } from "../useNlpSearch";

const center: [number, number] = [13.4, 52.5];
const bbox: BoundingBox = { south: 52.4, west: 13.3, north: 52.6, east: 13.5 };

describe("useNlpSearch", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("posts the query and map context to the parse endpoint", async () => {
    const response = { intent: {}, resolvedBbox: bbox, provider: "local", cached: false };
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue(response as never);

    const { result } = renderHook(() => useNlpSearch("coffee near me", center, bbox, true, "en"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    expect(spy).toHaveBeenCalledWith(API_ENDPOINTS.nlpParse, {
      query: "coffee near me",
      mapCenter: center,
      mapBbox: bbox,
      lang: "en",
      cloudAccess: "deny",
    });
  });

  it("includes explicit consent in the body when granted", async () => {
    const spy = vi
      .spyOn(apiClient, "post")
      .mockResolvedValue({ provider: "local", cached: false } as never);

    const { result } = renderHook(
      () => useNlpSearch("pizza places", center, bbox, true, undefined, "consented"),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.nlpParse,
      expect.objectContaining({ cloudAccess: "consented" }),
    );
  });

  it("does not fire when disabled", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);

    const { result } = renderHook(() => useNlpSearch("coffee shops", center, bbox, false), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fire for queries shorter than 4 characters", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);

    const { result } = renderHook(() => useNlpSearch("abc", center, bbox, true), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fire when map context is missing", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);

    const { result } = renderHook(() => useNlpSearch("coffee shops", null, bbox, true), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
