import { type Route, useSettingsStore } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test";

const runtime = vi.hoisted(() => ({
  browserAuthority: false,
  state: "native-compatible",
  commands: { start: vi.fn(async () => undefined) },
}));

vi.mock("./MobileRuntimeProvider", () => ({
  useMobileRuntimeContext: () => runtime,
}));

import { useStartNavigation } from "./useStartNavigation";

const route = {
  distance: 1_000,
  duration: 120,
  geometry: [
    [8.68, 50.11],
    [8.69, 50.12],
    [8.7, 50.13],
  ],
  steps: [],
  legs: [],
  mode: "driving",
} as unknown as Route;

describe("useStartNavigation.startGround under native authority", () => {
  const initialTiming = useSettingsStore.getState().voiceGuidanceTiming;
  afterEach(() => {
    useSettingsStore.getState().setVoiceGuidanceTiming(initialTiming);
    runtime.commands.start.mockClear();
  });

  it("starts the native session with the user's voice timing", async () => {
    useSettingsStore.getState().setVoiceGuidanceTiming("late");
    const { result } = renderHook(() => useStartNavigation());

    await act(() =>
      result.current.startGround({
        route,
        mode: "driving",
        destinationWaypoints: [[8.7, 50.13]],
        routeSelectionIntent: "automatic",
        routeOptions: {} as never,
        locale: "en",
        units: "metric",
      }),
    );

    expect(runtime.commands.start).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ voiceTiming: "late" }),
      }),
      undefined,
    );
  });
});
