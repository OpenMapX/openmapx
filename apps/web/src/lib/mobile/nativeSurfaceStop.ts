import { useNavigationStore } from "@openmapx/core";
/**
 * Applies a `session.stopped` the page did not ask for: native ended the trip
 * (the trip card, the recovery screen, its lifetime, an arrival whose window
 * closed). Only a stop for the session the page is showing clears it, so a
 * late notice for an earlier trip changes nothing.
 */
export function applyNativeSurfaceStop(sessionId: unknown): boolean {
  const store = useNavigationStore.getState();
  if (typeof sessionId !== "string" || store.nativeSessionId !== sessionId) return false;
  store.clearNativeReadModel();
  return true;
}
