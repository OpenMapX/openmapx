import { useDirectionsStore } from "@openmapx/core";
import { useTranslations } from "next-intl";

/**
 * What the rider called the trip's start and end when planning it, for
 * {@link tripPlaceName}. Read from the planned stops rather than the itinerary,
 * whose live refreshes bring the planner's placeholders back.
 */
export function useTripEndLabels(): { origin: string; destination: string } {
  const t = useTranslations("directions");
  const origin = useDirectionsStore((s) => s.waypoints[0]?.label);
  const destination = useDirectionsStore((s) => s.waypoints.at(-1)?.label);
  return { origin: origin || t("origin"), destination: destination || t("destination") };
}
