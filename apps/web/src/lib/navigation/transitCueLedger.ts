import { useNavigationStore } from "@openmapx/core";
/** Claim before speaking so remounts and transient confidence changes cannot replay a cue. */
export function claimBrowserTransitCue(id: string): boolean {
  const s = useNavigationStore.getState();
  const tick = s.transitTickState;
  if (
    s.navigationAuthority !== "browser" ||
    s.kind !== "transit" ||
    s.status !== "navigating" ||
    !tick ||
    tick.spokenCueIds.includes(id)
  )
    return false;
  useNavigationStore.setState({
    transitTickState: { ...tick, spokenCueIds: [...tick.spokenCueIds, id].slice(-512) },
  });
  return true;
}
