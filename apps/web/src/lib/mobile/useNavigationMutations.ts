"use client";

import { useNavigationStore, useSettingsStore, type VoiceGuidanceTiming } from "@openmapx/core";
import { useCallback } from "react";
import { useMobileRuntimeContext } from "./MobileRuntimeProvider";
import type { NavigationSettingsPatch } from "./navigationCommands";

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

  /**
   * Tells a running native session about a preference the page just stored.
   *
   * The preference is the user's and is always stored locally first; the
   * session holds its own copy because guidance runs natively, so any page that
   * changes one of these preferences (the in-trip menus, the settings dialog,
   * the preferences page) goes through here. With no native session there is
   * nothing to tell, and the next start carries the stored value.
   */
  const tellNativeSession = useCallback(
    async (patch: NavigationSettingsPatch) => {
      if (browserAuthority || !commands) return;
      if (useNavigationStore.getState().nativeSessionId === null) return;
      await commands.updateSettings(patch).catch(() => undefined);
    },
    [browserAuthority, commands],
  );

  const toggleVoice = useCallback(async () => {
    useNavigationStore.getState().toggleVoice();
    await tellNativeSession({ voiceEnabled: useNavigationStore.getState().voiceEnabled });
  }, [tellNativeSession]);

  const toggleKeepScreenOn = useCallback(async () => {
    useNavigationStore.getState().toggleKeepScreenOn();
    await tellNativeSession({ keepScreenOn: useNavigationStore.getState().keepScreenOn });
  }, [tellNativeSession]);

  const setVoiceTiming = useCallback(
    async (timing: VoiceGuidanceTiming) => {
      // The browser engine reads the preference on every cue.
      useSettingsStore.getState().setVoiceGuidanceTiming(timing);
      await tellNativeSession({ voiceTiming: timing });
    },
    [tellNativeSession],
  );

  return {
    endNavigation,
    completeArrival,
    toggleVoice,
    toggleKeepScreenOn,
    setVoiceTiming,
  } as const;
}
