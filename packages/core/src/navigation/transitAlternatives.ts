import type { TripItinerary } from "@openmapx/mobility-core/transit";
import type { TransitProgress } from "./transitProgress";
export function transitAlternativeOrigin(
  progress: TransitProgress | null,
  itinerary: TripItinerary,
  nowMs: number,
): { origin: [number, number]; time: string; preview: boolean; name?: string } | null {
  if (progress?.phase === "riding") {
    const leg = itinerary.legs[progress.currentLegIndex];
    if (!leg || !Number.isFinite(leg.to.lng) || !Number.isFinite(leg.to.lat)) return null;
    const expected = new Date(leg.endTime).getTime();
    return {
      origin: [leg.to.lng, leg.to.lat],
      time: new Date(Number.isFinite(expected) ? Math.max(nowMs, expected) : nowMs).toISOString(),
      preview: true,
      name: leg.to.name,
    };
  }
  if (
    !progress?.position ||
    !progress.positionTimestampMs ||
    nowMs - progress.positionTimestampMs > 30000 ||
    progress.positionTimestampMs > nowMs + 5000
  )
    return null;
  return { origin: progress.position, time: new Date(nowMs).toISOString(), preview: false };
}
