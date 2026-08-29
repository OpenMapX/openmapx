import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizedDepartureMinute, resolveTravelTimeBackend, useTravelTimeStore } from "../store";

const initial = useTravelTimeStore.getInitialState();

describe("travel-time reachability state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T10:12:43.987Z"));
    useTravelTimeStore.setState(initial, true);
  });

  afterEach(() => vi.useRealTimers());

  it("captures and clears a minute-normalized departure instant", () => {
    useTravelTimeStore.getState().activate();
    expect(useTravelTimeStore.getState().queryTime).toBe("2026-08-30T10:12:00.000Z");
    useTravelTimeStore.getState().deactivate();
    expect(useTravelTimeStore.getState().queryTime).toBeNull();
  });

  it("retains time for band changes and recaptures it for a transit origin change", () => {
    useTravelTimeStore.getState().activate();
    useTravelTimeStore.getState().setMode("transit");
    const first = useTravelTimeStore.getState().queryTime;
    vi.setSystemTime(new Date("2026-08-30T10:14:59.000Z"));
    useTravelTimeStore.getState().toggleMinutes(30);
    expect(useTravelTimeStore.getState().queryTime).toBe(first);
    useTravelTimeStore.getState().setOrigin([13.4, 52.5]);
    expect(useTravelTimeStore.getState().queryTime).toBe("2026-08-30T10:14:00.000Z");
  });

  it("keeps transit separate from street isochrone backends", () => {
    expect(resolveTravelTimeBackend("transit")).toEqual({ kind: "transit-reachability" });
    expect(resolveTravelTimeBackend("walking")).toEqual({
      kind: "street-isochrone",
      mode: "walking",
    });
  });

  it("validates explicit selected times", () => {
    expect(normalizedDepartureMinute("2026-08-30T23:59:59Z")).toBe("2026-08-30T23:59:00.000Z");
    expect(() => normalizedDepartureMinute("not-a-date")).toThrow("Invalid reachability time");
  });
});
