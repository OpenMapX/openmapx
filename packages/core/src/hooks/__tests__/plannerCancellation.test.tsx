import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { LngLat } from "../../types/geometry";
import { useTransitChainPlan } from "../transit/useTransitChainPlan";
import { useTransitRoute } from "../transit/useTransitRoute";
import { useDirections } from "../useDirections";
import { useEvDirections } from "../useEvDirections";
import { useRouteFlow } from "../useRouteFlow";
import { useScheduledDirections } from "../useScheduledDirections";

/** Every planner request in this file: it never answers and records its signal. */
const signals: AbortSignal[] = [];
function pending(signal: AbortSignal | undefined): Promise<never> {
  if (signal) signals.push(signal);
  return new Promise<never>(() => {});
}

vi.mock("../../api/directions", () => ({
  fetchDirections: (_params: unknown, _client: unknown, options?: { signal?: AbortSignal }) =>
    pending(options?.signal),
  postEvDirections: (_req: unknown, _client: unknown, options?: { signal?: AbortSignal }) =>
    pending(options?.signal),
  postScheduledDirections: (_req: unknown, _client: unknown, options?: { signal?: AbortSignal }) =>
    pending(options?.signal),
}));
vi.mock("../../api/roadConditions", () => ({
  fetchRouteFlow: (_routes: unknown, options?: { signal?: AbortSignal }) =>
    pending(options?.signal),
}));
vi.mock("../../api/transit", () => ({
  postTransitChainPlan: (_req: unknown, _client: unknown, options?: { signal?: AbortSignal }) =>
    pending(options?.signal),
}));
vi.mock("../../api/client", () => ({
  apiClient: {
    get: (_path: string, _query: unknown, options?: { signal?: AbortSignal }) =>
      pending(options?.signal),
  },
}));

const waypoints: [LngLat, LngLat] = [
  [13.4, 52.5],
  [13.5, 52.6],
];
const stops = [
  { lat: 52.5, lng: 13.4 },
  { lat: 52.55, lng: 13.45 },
  { lat: 52.6, lng: 13.5 },
];

const planners: Array<[string, () => unknown]> = [
  ["useDirections", () => useDirections({ waypoints, lang: "en" })],
  ["useEvDirections", () => useEvDirections({ waypoints, vehicleId: "ev", socStartPct: 80 })],
  ["useScheduledDirections", () => useScheduledDirections({ waypoints, mode: "driving" })],
  ["useRouteFlow", () => useRouteFlow([{ id: "r0", geometry: waypoints }], true)],
  ["useTransitChainPlan", () => useTransitChainPlan({ waypoints: stops })],
  ["useTransitRoute", () => useTransitRoute("ms:route 1")],
];

describe("routing planner cancellation", () => {
  beforeEach(() => {
    signals.length = 0;
  });

  it.each(planners)("%s aborts its request when the last observer unmounts", async (_, hook) => {
    const { unmount } = renderHook(hook, { wrapper: createQueryWrapper() });
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);

    unmount();

    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
  });

  it("aborts the superseded directions request when the trip changes", async () => {
    const { rerender } = renderHook(
      ({ to }: { to: LngLat }) => useDirections({ waypoints: [waypoints[0], to], lang: "en" }),
      {
        wrapper: createQueryWrapper(),
        initialProps: { to: waypoints[1] },
      },
    );
    await waitFor(() => expect(signals).toHaveLength(1));

    rerender({ to: [13.6, 52.7] });

    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});
