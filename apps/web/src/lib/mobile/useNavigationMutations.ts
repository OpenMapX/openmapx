"use client";

import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import type { VoiceTiming } from "@openmapx/core/navigation";
import { useCallback } from "react";
import { useMobileRuntimeContext } from "./MobileRuntimeProvider";
import { type NativeEndFailureKind, useNativeEndFailure } from "./nativeEndFailure";
import type { NavigationSettingsPatch } from "./navigationCommands";
import { CommandError } from "./navigationCommands";

/**
 * Ending a trip and changing its settings, under whichever authority owns it.
 *
 * The one rule that shapes all of this: never optimistically terminate native
 * tracking. Clearing the browser store first would hide the navigation UI while
 * the shell is still holding a location subscription, a foreground service, and
 * a notification — leaving the user with no way back to a trip that is very much
 * still running. So the store is only cleared once the shell has acknowledged,
 * and if the acknowledgement never comes the page reconciles from a full
 * snapshot instead of guessing. A refused or unanswered End is reported to the
 * user, because the trip they asked to end is still running.
 */
/**
 * A refusal means the trip is still running. No answer (a timeout, or a lost
 * channel) means native may or may not have ended it, and the user is told so.
 */
function endFailureKind(error: unknown): NativeEndFailureKind {
  return error instanceof CommandError && (error.code === "timeout" || error.code === "unavailable")
    ? "unconfirmed"
    : "refused";
}

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
      // Released only once native has agreed the trip is over.
      store.clearNativeReadModel();
    } catch (error) {
      // Native may well still be guiding. Ask what is actually true rather than
      // pretend the trip ended.
      useNativeEndFailure.getState().report(endFailureKind(error));
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
    } catch (error) {
      useNativeEndFailure.getState().report(endFailureKind(error));
      void commands.requestSnapshot();
      return false;
    }
  }, [browserAuthority, commands]);

  /**
   * Tells the native session about a preference the page just stored.
   *
   * The preference is the user's and is always stored locally first; the
   * session holds its own copy because guidance runs natively, so any page that
   * changes one of these preferences (the in-trip menus, the settings dialog,
   * the preferences page) goes through here. It is sent whether or not the page
   * has seen the session yet: a change made while a start is in flight waits
   * behind it in the command queue and lands on the new session, and one made
   * with no session is refused by native while the next start reads the stored
   * value.
   */
  const tellNativeSession = useCallback(
    async (patch: NavigationSettingsPatch) => {
      if (browserAuthority || !commands) return;
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
    async (timing: VoiceTiming) => {
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
