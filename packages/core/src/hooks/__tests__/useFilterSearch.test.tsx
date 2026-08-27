import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { BoundingBox } from "../../types/geometry";
import type { OverpassFilter } from "../../utils/overpassFilter";
import { useFilterSearch } from "../useFilterSearch";

const bbox: BoundingBox = { south: 52.4, west: 13.3, north: 52.6, east: 13.5 };

const validFilter: OverpassFilter = {
  selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }],
};

describe("useFilterSearch", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("POSTs to poiFilter with filter + bbox and returns results", async () => {
    const response = {
      results: [
        { id: "osm:node/1", name: "Cafe Test", coordinates: [13.4, 52.5] as [number, number] },
      ],
      partial: false,
    };
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue(response as never);

    const { result } = renderHook(() => useFilterSearch(validFilter, bbox, "en"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.poiFilter,
      {
        filter: validFilter,
        south: bbox.south,
        west: bbox.west,
        north: bbox.north,
        east: bbox.east,
        lang: "en",
      },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("omits lang when not supplied", async () => {
    const spy = vi
      .spyOn(apiClient, "post")
      .mockResolvedValue({ results: [], partial: false } as never);

    const { result } = renderHook(() => useFilterSearch(validFilter, bbox), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.poiFilter,
      expect.not.objectContaining({ lang: expect.anything() }),
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("does not fire when filter.selectors is empty", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);

    const emptyFilter: OverpassFilter = { selectors: [] };
    const { result } = renderHook(() => useFilterSearch(emptyFilter, bbox), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fire when bbox is null", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);

    const { result } = renderHook(() => useFilterSearch(validFilter, null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fire when filter is null", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);

    const { result } = renderHook(() => useFilterSearch(null, bbox), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
