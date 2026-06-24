import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { LngLat } from "../../types/geometry";
import { directionsQueryKey, useDirections } from "../useDirections";

const fetchDirections = vi.fn();
vi.mock("../../api/directions", () => ({
  fetchDirections: (...args: unknown[]) => fetchDirections(...args),
}));

const waypoints: LngLat[] = [
  [13.4, 52.5],
  [13.5, 52.6],
];

describe("useDirections", () => {
  beforeEach(() => {
    fetchDirections.mockReset();
  });

  it("fetches directions and forwards normalized options to fetchDirections", async () => {
    const route = { routes: [{ distance: 100 }] };
    fetchDirections.mockResolvedValue(route);

    const { result } = renderHook(
      () =>
        useDirections({
          waypoints,
          mode: "driving",
          avoidHighways: true,
          avoidTolls: true,
          avoidFerries: false,
          units: "metric",
          lang: "en",
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(route);
    expect(fetchDirections).toHaveBeenCalledWith(
      expect.objectContaining({
        waypoints,
        mode: "driving",
        avoidHighways: true,
        avoidTolls: true,
        avoidFerries: false,
        units: "metric",
        lang: "en",
      }),
    );
  });

  it("clears avoidHighways/avoidTolls for non-driving modes", async () => {
    fetchDirections.mockResolvedValue({ routes: [] });

    const { result } = renderHook(
      () => useDirections({ waypoints, mode: "cycling", avoidHighways: true, avoidTolls: true }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchDirections).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "cycling", avoidHighways: false, avoidTolls: false }),
    );
  });

  it("does not fire with fewer than two waypoints", () => {
    const { result } = renderHook(() => useDirections({ waypoints: [[13.4, 52.5]] }), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchDirections).not.toHaveBeenCalled();
  });
});

describe("directionsQueryKey", () => {
  it("includes every cache-affecting param so callers can't drift", () => {
    const key = directionsQueryKey({
      waypoints,
      mode: "driving",
      avoidHighways: true,
      avoidTolls: false,
      avoidFerries: true,
      avoidClosures: true,
      units: "imperial",
      lang: "de",
      departAt: "2026-06-24T10:00",
    });
    expect(key).toEqual([
      "directions",
      "13.4,52.5;13.5,52.6",
      "driving",
      true, // effective avoidHighways (driving)
      false, // effective avoidTolls
      true, // avoidFerries
      true, // avoidClosures
      "imperial",
      "de",
      "2026-06-24T10:00",
      undefined, // arriveBy
    ]);
  });

  it("collapses avoidHighways/avoidTolls for non-driving modes (matches the query)", () => {
    const key = directionsQueryKey({
      waypoints,
      mode: "cycling",
      avoidHighways: true,
      avoidTolls: true,
    });
    expect(key[3]).toBe(false);
    expect(key[4]).toBe(false);
  });

  it("produces identical keys for identical params", () => {
    const p = { waypoints, mode: "driving" as const, avoidClosures: true };
    expect(directionsQueryKey(p)).toEqual(directionsQueryKey(p));
  });
});
