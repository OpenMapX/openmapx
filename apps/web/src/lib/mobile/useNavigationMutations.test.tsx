import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test";

const runtime = vi.hoisted(() => ({
  browserAuthority: true,
  commands: null as null | {
    stop: ReturnType<typeof vi.fn>;
    requestSnapshot: ReturnType<typeof vi.fn>;
    updateSettings?: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("./MobileRuntimeProvider", () => ({
  useMobileRuntimeContext: () => runtime,
}));

import { useNavigationMutations } from "./useNavigationMutations";

describe("useNavigationMutations.completeArrival", () => {
  beforeEach(() => {
    runtime.browserAuthority = true;
    runtime.commands = null;
  });

  it("acknowledges browser-owned completion", async () => {
    const stopNavigation = vi.spyOn(useNavigationStore.getState(), "stopNavigation");
    const { result } = renderHook(() => useNavigationMutations());

    await expect(act(() => result.current.completeArrival())).resolves.toBe(true);
    expect(stopNavigation).toHaveBeenCalledTimes(1);
  });

  it("returns false and reconciles when native refuses to stop", async () => {
    const requestSnapshot = vi.fn(async () => undefined);
    runtime.browserAuthority = false;
    runtime.commands = {
      stop: vi.fn(async () => {
        throw new Error("native stop failed");
      }),
      requestSnapshot,
    };
    const { result } = renderHook(() => useNavigationMutations());

    await expect(act(() => result.current.completeArrival())).resolves.toBe(false);
    expect(requestSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns false when native authority has no command channel", async () => {
    runtime.browserAuthority = false;
    const { result } = renderHook(() => useNavigationMutations());

    await expect(act(() => result.current.completeArrival())).resolves.toBe(false);
  });
});

describe("useNavigationMutations.setVoiceTiming", () => {
  const initialTiming = useSettingsStore.getState().voiceGuidanceTiming;
  beforeEach(() => {
    runtime.browserAuthority = true;
    runtime.commands = null;
  });
  afterEach(() => {
    useSettingsStore.getState().setVoiceGuidanceTiming(initialTiming);
    useNavigationStore.setState({ nativeSessionId: null });
  });

  it("stores the preference for a browser-owned trip", async () => {
    const { result } = renderHook(() => useNavigationMutations());

    await act(() => result.current.setVoiceTiming("early"));

    expect(useSettingsStore.getState().voiceGuidanceTiming).toBe("early");
  });

  it("tells the native session as well as storing the preference", async () => {
    const updateSettings = vi.fn(async () => undefined);
    useNavigationStore.setState({ nativeSessionId: "trip-1" });
    runtime.browserAuthority = false;
    runtime.commands = { stop: vi.fn(), requestSnapshot: vi.fn(), updateSettings };
    const { result } = renderHook(() => useNavigationMutations());

    await act(() => result.current.setVoiceTiming("late"));

    expect(useSettingsStore.getState().voiceGuidanceTiming).toBe("late");
    expect(updateSettings).toHaveBeenCalledWith({ voiceTiming: "late" });
  });
});
