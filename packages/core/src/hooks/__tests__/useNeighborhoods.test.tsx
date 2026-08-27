import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { BBox } from "../../types/geometry";
import { useNeighborhoods } from "../useNeighborhoods";

const bbox: BBox = [13.3, 52.4, 13.5, 52.6];

describe("useNeighborhoods", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches neighbourhoods for the bbox and forwards lang", async () => {
    const response = { neighborhoods: [{ name: "Mitte" }] };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(response as never);

    const { result } = renderHook(() => useNeighborhoods(bbox, "en"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.neighborhoods,
      { west: "13.3", south: "52.4", east: "13.5", north: "52.6", lang: "en" },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("omits lang when not supplied", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ neighborhoods: [] } as never);

    const { result } = renderHook(() => useNeighborhoods(bbox), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.neighborhoods,
      expect.not.objectContaining({ lang: expect.anything() }),
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("does not fire when the bbox is null", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ neighborhoods: [] } as never);

    const { result } = renderHook(() => useNeighborhoods(null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
