import { useNavigationStore } from "@openmapx/core";
/** Existing unsolicited session.stopped messages may come from native confirmation. */
export function applyNativeSurfaceStop(sessionId: unknown): boolean {
  const store = useNavigationStore.getState();
  if (typeof sessionId !== "string" || store.nativeSessionId !== sessionId) return false;
  store.clearNativeReadModel();
  return true;
}
