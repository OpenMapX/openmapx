import { beforeEach, describe, expect, it } from "vitest";
import { useSunTimeStore } from "../store";

describe("useSunTimeStore", () => {
  beforeEach(() => {
    useSunTimeStore.setState({ showTerminator: true, showTimeZones: false, timeMs: null });
  });

  it("shows the terminator and hides time zones by default", () => {
    const state = useSunTimeStore.getState();
    expect(state.showTerminator).toBe(true);
    expect(state.showTimeZones).toBe(false);
    expect(state.timeMs).toBeNull();
  });

  it("pins and releases the instant", () => {
    useSunTimeStore.getState().setTimeMs(1_800_000_000_000);
    expect(useSunTimeStore.getState().timeMs).toBe(1_800_000_000_000);
    useSunTimeStore.getState().resetToNow();
    expect(useSunTimeStore.getState().timeMs).toBeNull();
  });

  it("releases the pinned instant when the panel closes", () => {
    useSunTimeStore.getState().setTimeMs(1_800_000_000_000);
    useSunTimeStore.getState().closePanel();
    expect(useSunTimeStore.getState().timeMs).toBeNull();
  });
});
