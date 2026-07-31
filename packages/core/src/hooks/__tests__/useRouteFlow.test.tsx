import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "../../api/roadConditions";
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
});
