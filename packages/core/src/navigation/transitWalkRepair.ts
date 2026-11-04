import { contributorsForField } from "@openmapx/mobility-core/contributors";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import type { Route } from "../types/routing";
import { haversineDistance } from "../utils/coordinates";
/** Repair the access, transfer or egress path without changing any selected ride. */
export function repairTransitWalk(
  itinerary: TripItinerary,
  index: number,
  route: Route,
): TripItinerary | null {
  const leg = itinerary.legs[index];
  const end = route.geometry.at(-1);
  if (
    leg?.mode !== "walking" ||
    route.mode !== "walking" ||
    !end ||
    route.geometry.length < 2 ||
    !Number.isFinite(leg.to.lng) ||
    !Number.isFinite(leg.to.lat) ||
    haversineDistance(end, [leg.to.lng, leg.to.lat]) > 50
  )
    return null;
  return {
    ...itinerary,
    legs: itinerary.legs.map((l, i) =>
      i === index
        ? {
            ...l,
            geometry: {
              type: "LineString",
              coordinates: route.geometry,
              contributors: contributorsForField(route, "geometry"),
            },
            distanceMeters: route.distance,
            durationSeconds: route.duration,
            contributors: route.contributors,
            fieldContributors: { ...l.fieldContributors, ...route.fieldContributors },
            steps: route.steps.map((step) => ({
              instruction: walkDirection(step.maneuver),
              instructionText: step.instruction,
              coordinates: step.coordinates,
              distanceMeters: step.distance,
              durationSeconds: step.duration,
              contributors: step.contributors,
              fieldContributors: step.fieldContributors,
            })),
          }
        : l,
    ),
  };
}

/** Keep normalized ground-route turns when translating into the transit step vocabulary. */
function walkDirection(maneuver: Route["steps"][number]["maneuver"]): string {
  if (maneuver?.type === "depart") return "DEPART";
  if (maneuver?.type === "stairs") return "STAIRS";
  if (maneuver?.type === "elevator") return "ELEVATOR";
  if (maneuver?.type === "roundabout" || maneuver?.type === "rotary")
    return maneuver.modifier === "left" ? "CIRCLE_COUNTERCLOCKWISE" : "CIRCLE_CLOCKWISE";
  return (
    (
      {
        left: "LEFT",
        right: "RIGHT",
        "slight left": "SLIGHTLY_LEFT",
        "slight right": "SLIGHTLY_RIGHT",
        "sharp left": "HARD_LEFT",
        "sharp right": "HARD_RIGHT",
        uturn: "UTURN_LEFT",
      } as Record<string, string>
    )[maneuver?.modifier ?? ""] ?? "CONTINUE"
  );
}
