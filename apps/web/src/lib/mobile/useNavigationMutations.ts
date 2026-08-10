"use client";

import { useNavigationStore } from "@openmapx/core";
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

  const completeArrival = useCallback(async () => {
    const store = useNavigationStore.getState();
    if (browserAuthority) {
      store.stopNavigation();
      return;
    }
    if (!commands) return;
    try {
      await commands.stop(true);
      store.clearNativeReadModel();
    } catch {
      void commands.requestSnapshot();
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

  return { endNavigation, completeArrival, toggleVoice, toggleKeepScreenOn } as const;
}
