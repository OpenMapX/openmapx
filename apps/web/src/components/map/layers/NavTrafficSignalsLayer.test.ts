import { describe, expect, it, vi } from "vitest";
import {
  NAV_TRAFFIC_SIGNALS_LAYER_ID,
  orderNavTrafficSignalsLayer,
} from "./NavTrafficSignalsLayer";

describe("orderNavTrafficSignalsLayer", () => {
  it("moves the traffic-light layer to the top so it sits above the route", () => {
    const moveLayer = vi.fn();
    const existing = new Set([NAV_TRAFFIC_SIGNALS_LAYER_ID]);
    orderNavTrafficSignalsLayer({
      getLayer: (id: string) => (existing.has(id) ? ({ id } as never) : undefined),
      moveLayer,
    });
    expect(moveLayer.mock.calls).toEqual([[NAV_TRAFFIC_SIGNALS_LAYER_ID]]);
  });

  it("no-ops when the layer has not been created yet", () => {
    const moveLayer = vi.fn();
    orderNavTrafficSignalsLayer({ getLayer: () => undefined, moveLayer });
    expect(moveLayer).not.toHaveBeenCalled();
  });
});
