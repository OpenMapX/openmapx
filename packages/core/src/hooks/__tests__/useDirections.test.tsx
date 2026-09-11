import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  afterEach(() => vi.useRealTimers());

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
      () =>
        useDirections({
          waypoints,
          mode: "cycling",
          avoidHighways: true,
          avoidTolls: true,
          lang: "de",
        }),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchDirections).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "cycling", avoidHighways: false, avoidTolls: false }),
    );
  });

  it("does not fire with fewer than two waypoints", () => {
    const { result } = renderHook(() => useDirections({ waypoints: [[13.4, 52.5]], lang: "de" }), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchDirections).not.toHaveBeenCalled();
  });

  it("stops presenting a held road-condition assessment as current at its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    fetchDirections.mockResolvedValue({
      waypoints,
      routes: [],
      activeRouteIndex: 0,
      roadConditionImpact: {
        availability: "current",
        evaluatedAt: "2026-09-12T12:00:00Z",
        validUntil: "2026-09-12T12:00:01Z",
        reasons: [],
      },
    });

    const { result } = renderHook(() => useDirections({ waypoints, mode: "driving", lang: "en" }), {
      wrapper: createQueryWrapper(),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data?.roadConditionImpact?.availability).toBe("current");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(result.current.data?.roadConditionImpact).toMatchObject({
      availability: "expired",
      validUntil: "2026-09-12T12:00:01Z",
      reasons: ["evidence_expired"],
    });
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
      lang: "de",
    });
    expect(key[3]).toBe(false);
    expect(key[4]).toBe(false);
  });

  it("produces identical keys for identical params", () => {
    const p = { waypoints, mode: "driving" as const, avoidClosures: true, lang: "de" };
    expect(directionsQueryKey(p)).toEqual(directionsQueryKey(p));
  });
});
