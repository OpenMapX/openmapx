"use client";

import { useNavigationConnectivity } from "@/lib/navigation/navigationConnectivity";

/**
 * Keeps `navigationStore.connectivity` synced to the browser's online/offline
 * signal for the whole life of the map page — not just while a ground trip is
 * active. `startGroundNavigation` reads `current.connectivity` synchronously
 * at the moment "Start" is pressed (to seed `rerouteUnavailable` /
 * `liveDataUnavailable` for the new session), which is before the runtime
 * that owns the rest of navigation's live-fix machinery has had a chance to
 * mount. Mounted as its own leaf (rather than inside the gate component body)
 * so its rare online/offline re-renders never cascade into the cold controls
 * tree the way a subscription in the gate itself would.
 */
export function NavigationConnectivityTracker() {
  useNavigationConnectivity();
  return null;
}
