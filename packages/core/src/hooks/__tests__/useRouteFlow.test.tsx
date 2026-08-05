import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "../../api/roadConditions";
import * as flowProjection from "../../navigation/flowProjection";
import { createQueryWrapper } from "../../test/queryWrapper";
import { routeFlowQueryKey, useRouteFlow } from "../useRouteFlow";

const route = { id: "r0", geometry: [[8, 50] as [number, number], [8, 50.01] as [number, number]] };

describe("routeFlowQueryKey", () => {
  it("changes when the geometry changes", () => {
    const a = routeFlowQueryKey([route]);
    const b = routeFlowQueryKey([
      {
        ...route,
        geometry: [
          [8, 50],
          [8, 50.02],
        ],
      },
    ]);
    expect(a).not.toEqual(b);
  });
});

describe("useRouteFlow", () => {
  it("does not fetch when disabled", () => {
    const spy = vi.spyOn(api, "fetchRouteFlow");
    renderHook(() => useRouteFlow([route], false), { wrapper: createQueryWrapper() });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns the spans keyed by route id when enabled", async () => {
    const spy = vi.spyOn(api, "fetchRouteFlow").mockResolvedValue({
      r0: [{ startMeters: 0, endMeters: 100, los: "heavy", confidence: "measured" }],
    });
    const { result } = renderHook(() => useRouteFlow([route], true), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.r0).toBeDefined());
    expect(result.current.r0[0].los).toBe("heavy");
    spy.mockRestore();
  });

  it("does not re-hash the route geometry on a re-render that keeps the same input array identity", () => {
    // `routeFlowQueryKey` (and, inside it, `routeFingerprint`) is expensive to
    // rerun on every render once `routes` has settled — that is the whole
    // reason it sits behind its own `useMemo`. `fetchRouteFlow` doesn't prove
    // this (the query is disabled here), so watch the fingerprinting call
    // itself instead.
    const fetchSpy = vi.spyOn(api, "fetchRouteFlow");
    const fingerprintSpy = vi.spyOn(flowProjection, "routeFingerprint");
    const stableRoutes = [route];

    const { rerender } = renderHook(({ routes }) => useRouteFlow(routes, false), {
      wrapper: createQueryWrapper(),
      initialProps: { routes: stableRoutes },
    });
    expect(fingerprintSpy).toHaveBeenCalledTimes(1);

    rerender({ routes: stableRoutes });
    rerender({ routes: stableRoutes });

    expect(fingerprintSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
    fingerprintSpy.mockRestore();
  });
});
