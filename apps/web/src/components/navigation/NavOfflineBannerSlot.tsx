"use client";

import { useNavigationStore } from "@openmapx/core";
import type { OfflineRouteCoverage } from "@/lib/navigation/offlineRouteCoverage";
import { OfflineNavigationBanner } from "./OfflineNavigationBanner";

interface Props {
  coverage: OfflineRouteCoverage;
}

/**
 * Wraps `OfflineNavigationBanner` in its own subscription to
 * connectivity/reroute/live-data/off-route/rerouting state — none of which is
 * `progress` — so it re-renders on those (infrequent) changes without being
 * tied to whatever re-render cadence its parent happens to have.
 */
export function NavOfflineBannerSlot({ coverage }: Props) {
  const connectivity = useNavigationStore((s) => s.connectivity);
  const rerouteUnavailable = useNavigationStore((s) => s.rerouteUnavailable);
  const liveDataUnavailable = useNavigationStore((s) => s.liveDataUnavailable);
  const offRoute = useNavigationStore((s) => s.offRoute);
  const rerouting = useNavigationStore((s) => s.status === "rerouting");
  const requestRerouteRetry = useNavigationStore((s) => s.requestRerouteRetry);

  return (
    <OfflineNavigationBanner
      connectivity={connectivity}
      rerouteUnavailable={rerouteUnavailable}
      liveDataUnavailable={liveDataUnavailable}
      coverage={coverage}
      offRoute={offRoute}
      rerouting={rerouting}
      onRetryReroute={requestRerouteRetry}
    />
  );
}
