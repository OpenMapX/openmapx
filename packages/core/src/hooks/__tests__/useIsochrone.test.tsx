import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { LngLat } from "../../types/geometry";
import { useIsochrone } from "../useIsochrone";

const origin: LngLat = [13.4, 52.5];

describe("useIsochrone", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches with sorted contours joined into the contours param", async () => {
    const isochrone = { features: [] };
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue(isochrone as never);

    const { result } = renderHook(
      () => useIsochrone({ origin, mode: "driving", contourMinutes: [15, 5, 10] }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(isochrone);
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.isochrone,
      { lat: "52.5", lng: "13.4", mode: "driving", contours: "5,10,15" },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 20_000 }),
    );
  });

  it("does not fire when origin is null", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(
      () => useIsochrone({ origin: null, mode: "driving", contourMinutes: [10] }),
      { wrapper: createQueryWrapper() },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fire when there are no contour minutes", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(
      () => useIsochrone({ origin, mode: "driving", contourMinutes: [] }),
      { wrapper: createQueryWrapper() },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fire when explicitly disabled", () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({} as never);

    const { result } = renderHook(
      () => useIsochrone({ origin, mode: "driving", contourMinutes: [10], enabled: false }),
      { wrapper: createQueryWrapper() },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
