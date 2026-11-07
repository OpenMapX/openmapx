import { beforeEach, describe, expect, it } from "vitest";
import { useSunTimeStore } from "../store";

describe("useSunTimeStore", () => {
  beforeEach(() => {
    useSunTimeStore.setState({ showTerminator: true, showTimeZones: false, timeMs: null });
  });

  it("releases the pinned instant when the panel closes", () => {
    useSunTimeStore.getState().setTimeMs(1_800_000_000_000);
    useSunTimeStore.getState().closePanel();
    expect(useSunTimeStore.getState().timeMs).toBeNull();
  });
});
