"use client";

import { useNavigationStore, useSettingsStore, type VoiceGuidanceTiming } from "@openmapx/core";
import { useCallback } from "react";
import { useMobileRuntimeContext } from "./MobileRuntimeProvider";

/**
 * Ending a trip and changing its settings, under whichever authority owns it.
 *
 * The one rule that shapes all of this: never optimistically terminate native
 * tracking. Clearing the browser store first would hide the navigation UI while
 * the shell is still holding a location subscription, a foreground service, and
 * a notification — leaving the user with no way back to a trip that is very much
 * still running. So the store is only cleared once the shell has acknowledged,
 * and if the acknowledgement never comes the page reconciles from a full
 * snapshot instead of guessing.
 */
export function useNavigationMutations() {
  const runtime = useMobileRuntimeContext();
  const browserAuthority = runtime.browserAuthority;
  const commands = runtime.commands;

  const endNavigation = useCallback(async () => {
    const store = useNavigationStore.getState();
    if (browserAuthority) {
      store.stopNavigation();
      return;
    }
    if (!commands) return;
    try {
      await commands.stop();
      // The terminal snapshot that follows is what clears the read model; this
      // only releases the page's own copy once native has agreed it is over.
      store.clearNativeReadModel();
    } catch {
      // Native may well still be guiding. Ask what is actually true rather than
      // pretend the trip ended.
      void commands.requestSnapshot();
    }
  }, [browserAuthority, commands]);

  const completeArrival = useCallback(async (): Promise<boolean> => {
    const store = useNavigationStore.getState();
    if (browserAuthority) {
      store.stopNavigation();
      return true;
    }
    if (!commands) return false;
    try {
      await commands.stop(true);
      store.clearNativeReadModel();
      return true;
    } catch {
      void commands.requestSnapshot();
      return false;
    }
  }, [browserAuthority, commands]);

  const toggleVoice = useCallback(async () => {
    const store = useNavigationStore.getState();
    if (browserAuthority || !commands) {
      store.toggleVoice();
      return;
    }
    // The preference is still stored locally — it is the user's, not the
    // session's — but the speaking is native, so native has to be told.
    store.toggleVoice();
    await commands
      .updateSettings({ voiceEnabled: useNavigationStore.getState().voiceEnabled })
      .catch(() => undefined);
  }, [browserAuthority, commands]);

  const toggleKeepScreenOn = useCallback(async () => {
    const store = useNavigationStore.getState();
    if (browserAuthority || !commands) {
      store.toggleKeepScreenOn();
      return;
    }
    store.toggleKeepScreenOn();
    await commands
      .updateSettings({ keepScreenOn: useNavigationStore.getState().keepScreenOn })
      .catch(() => undefined);
  }, [browserAuthority, commands]);

  const setVoiceTiming = useCallback(
    async (timing: VoiceGuidanceTiming) => {
      // The browser engine reads the preference on every cue; native has its own
      // copy in the session, so a native trip has to be told.
      useSettingsStore.getState().setVoiceGuidanceTiming(timing);
      if (browserAuthority || !commands) return;
      await commands.updateSettings({ voiceTiming: timing }).catch(() => undefined);
    },
    [browserAuthority, commands],
  );

  return {
    endNavigation,
    completeArrival,
    toggleVoice,
    toggleKeepScreenOn,
    setVoiceTiming,
  } as const;
}
