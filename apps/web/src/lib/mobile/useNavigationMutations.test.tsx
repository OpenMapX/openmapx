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

import { useNativeEndFailure } from "./nativeEndFailure";
import { useNavigationMutations } from "./useNavigationMutations";

describe("useNavigationMutations.endNavigation", () => {
  beforeEach(() => {
    runtime.browserAuthority = false;
    useNativeEndFailure.getState().dismiss();
  });

  it("tells the user and reconciles when native refuses to end the trip", async () => {
    const clear = vi.spyOn(useNavigationStore.getState(), "clearNativeReadModel");
    const requestSnapshot = vi.fn(async () => undefined);
    runtime.commands = {
      stop: vi.fn(async () => {
        throw new Error("native stop refused");
      }),
      requestSnapshot,
    };
    const { result } = renderHook(() => useNavigationMutations());

    await act(() => result.current.endNavigation());

    expect(useNativeEndFailure.getState().failed).toBe(true);
    expect(requestSnapshot).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    clear.mockRestore();
  });

  it("clears the page's copy once native has ended the trip, reporting nothing", async () => {
    const clear = vi.spyOn(useNavigationStore.getState(), "clearNativeReadModel");
    runtime.commands = { stop: vi.fn(async () => undefined), requestSnapshot: vi.fn() };
    const { result } = renderHook(() => useNavigationMutations());

    await act(() => result.current.endNavigation());

    expect(clear).toHaveBeenCalledTimes(1);
    expect(useNativeEndFailure.getState().failed).toBe(false);
    clear.mockRestore();
  });
});

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
  });

  it("stores the preference for a browser-owned trip", async () => {
    const { result } = renderHook(() => useNavigationMutations());

    await act(() => result.current.setVoiceTiming("early"));

    expect(useSettingsStore.getState().voiceGuidanceTiming).toBe("early");
  });

  it("tells the native session as well as storing the preference", async () => {
    const updateSettings = vi.fn(async () => undefined);
    runtime.browserAuthority = false;
    runtime.commands = { stop: vi.fn(), requestSnapshot: vi.fn(), updateSettings };
    const { result } = renderHook(() => useNavigationMutations());

    await act(() => result.current.setVoiceTiming("late"));

    expect(useSettingsStore.getState().voiceGuidanceTiming).toBe("late");
    expect(updateSettings).toHaveBeenCalledWith({ voiceTiming: "late" });
  });
});

describe("useNavigationMutations toggles before the page has a native read model", () => {
  const initial = useNavigationStore.getState();
  afterEach(() => {
    useNavigationStore.setState({
      voiceEnabled: initial.voiceEnabled,
      keepScreenOn: initial.keepScreenOn,
      nativeSessionId: initial.nativeSessionId,
    });
  });

  it("still sends the change, so a session started a moment ago receives it", async () => {
    const updateSettings = vi.fn(async () => undefined);
    useNavigationStore.setState({ voiceEnabled: true, keepScreenOn: true, nativeSessionId: null });
    runtime.browserAuthority = false;
    runtime.commands = { stop: vi.fn(), requestSnapshot: vi.fn(), updateSettings };
    const { result } = renderHook(() => useNavigationMutations());

    await act(() => result.current.toggleVoice());
    await act(() => result.current.toggleKeepScreenOn());

    expect(updateSettings).toHaveBeenCalledWith({ voiceEnabled: false });
    expect(updateSettings).toHaveBeenCalledWith({ keepScreenOn: false });
  });
});
