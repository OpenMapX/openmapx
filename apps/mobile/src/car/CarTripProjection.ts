import type { ManeuverLane, ManeuverSign } from "@openmapx/core";
import type { GroundFullSnapshot } from "@openmapx/core/navigation";
import {
  type GuidanceIconName,
  guidanceApproachMeters,
  guidanceLanesForStep,
  maneuverIconName,
  measurementDistanceParts,
  presentGuidanceLanes,
  upcomingManeuverIndex,
} from "@openmapx/core/navigation";
import { z } from "zod";

const nonnegative = z.number().finite().nonnegative();
/** The phone banner's rounding (`measurementDistanceParts`), so the car shows the same. */
const displayDistance = z.object({
  value: nonnegative,
  unit: z.enum(["m", "km", "ft", "mi"]),
  decimals: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});
export const carTripProjectionSchema = z.object({
  sessionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  maneuverId: z.string().max(256),
  instruction: z.string().min(1).max(1024),
  /** The phone's arrow glyph for this maneuver (shared `maneuverIconName`). */
  maneuverIcon: z.string().max(32),
  /** Lane cells exactly as the phone draws them, once the maneuver is near. */
  lanes: z
    .array(
      z.object({
        valid: z.boolean(),
        arrows: z
          .array(
            z.object({
              icon: z.string().max(32),
              active: z.boolean(),
              stemShift: z.number().finite().min(-1).max(1),
            }),
          )
          .max(8),
      }),
    )
    .max(12)
    .optional(),
  /** A roundabout's exit number and circling direction; the turn type follows the glyph. */
  roundabout: z
    .object({ exit: z.number().int().min(1).max(99), clockwise: z.boolean() })
    .optional(),
  distanceToManeuver: nonnegative,
  maneuverDistance: displayDistance,
  remainingDistanceDisplay: displayDistance,
  secondsToManeuver: nonnegative,
  maneuverEtaMs: nonnegative,
  remainingDistance: nonnegative,
  remainingSeconds: nonnegative,
  etaMs: nonnegative,
  rerouting: z.boolean(),
  locale: z.enum(["en", "de"]),
  units: z.enum(["metric", "imperial"]),
});
export type CarTripProjection = z.infer<typeof carTripProjectionSchema>;
const stepSchema = z.object({
  distance: nonnegative.optional(),
  duration: nonnegative.optional(),
  drivingSide: z.enum(["left", "right"]).optional(),
  instruction: z.string().optional(),
  lanes: z
    .array(
      z.object({
        indications: z.array(z.string().max(32)).max(8),
        valid: z.boolean(),
        active: z.string().max(32).optional(),
      }),
    )
    .max(12)
    .optional(),
  roundaboutExitCount: z.number().optional(),
  motorway: z.boolean().optional(),
  sign: z.unknown().optional(),
  maneuver: z
    .object({ type: z.string(), modifier: z.string().optional(), exit: z.number().optional() })
    .optional(),
});
const progressSchema = z.object({
  currentStepIndex: z.number().int().nonnegative(),
  distanceToNextManeuver: nonnegative,
  distanceRemaining: nonnegative,
  durationRemaining: nonnegative,
  speedMps: z.number().finite().optional(),
});
/**
 * Only the container: the session boundary already validated the route, and a car tick
 * reads at most two steps, so each read step is checked with `stepSchema` on its own.
 */
const routeContainerSchema = z.object({
  steps: z.custom<unknown[]>((value) => Array.isArray(value)),
  distance: nonnegative.optional(),
  duration: nonnegative.optional(),
});
const rerouteSchema = z.object({ status: z.string() });
type CarStep = z.infer<typeof stepSchema>;

/** An index past either end reads no step; a malformed step at a real index is a failure. */
function readStep(steps: unknown[], index: number): { step: CarStep | undefined } | null {
  if (index < 0 || index >= steps.length) return { step: undefined };
  const parsed = stepSchema.safeParse(steps[index]);
  return parsed.success ? { step: parsed.data } : null;
}

/** The maneuver is at the START of the next step, not the step being driven. */
export function buildCarTripProjection(
  snapshot: Pick<
    GroundFullSnapshot,
    "status" | "route" | "progress" | "reroute" | "locale" | "units" | "sessionId" | "revision"
  >,
  now: number,
): CarTripProjection | null {
  if (snapshot.status !== "active") return null;
  const route = routeContainerSchema.safeParse(snapshot.route);
  const progress = progressSchema.safeParse(snapshot.progress);
  if (!route.success) return null;
  if (!progress.success && snapshot.progress != null) return null;
  const p = progress.success
    ? progress.data
    : {
        currentStepIndex: -1,
        distanceToNextManeuver: 0,
        distanceRemaining: route.data.distance ?? 0,
        durationRemaining: route.data.duration ?? 0,
      };
  const steps = route.data.steps;
  const upcomingIndex = upcomingManeuverIndex(p.currentStepIndex, steps.length);
  const currentIndex = Math.max(0, p.currentStepIndex);
  const upcoming = readStep(steps, upcomingIndex);
  const current = currentIndex === upcomingIndex ? upcoming : readStep(steps, currentIndex);
  if (!upcoming || !current) return null;
  const step = upcoming.step;
  const m = step?.maneuver;
  const roundabout = m?.type === "roundabout" || m?.type === "rotary";
  const reroute = rerouteSchema.safeParse(snapshot.reroute);
  const currentStep = current.step;
  const showLanes =
    !!step?.lanes &&
    !!m &&
    p.distanceToNextManeuver <=
      guidanceApproachMeters("driving", "speedMps" in p ? (p.speedMps ?? 0) : 0);
  // Narrowed for a close second maneuver like the phone's banner; the step
  // after the upcoming one is read only while lanes are shown.
  const following = showLanes ? readStep(steps, upcomingIndex + 1) : null;
  const laneSteps = [
    currentIndex === upcomingIndex - 1 ? currentStep : undefined,
    step,
    following?.step,
  ].map((laneStep) => ({
    distance: laneStep?.distance ?? Number.POSITIVE_INFINITY,
    ...(laneStep?.maneuver ? { maneuver: laneStep.maneuver } : {}),
    ...(laneStep?.motorway !== undefined ? { motorway: laneStep.motorway } : {}),
  }));
  const shownLanes = showLanes
    ? guidanceLanesForStep(
        laneSteps,
        1,
        step?.lanes as ManeuverLane[] | undefined,
        following?.step?.lanes as ManeuverLane[] | undefined,
      )
    : undefined;
  const secondsToManeuver =
    currentStep?.distance && currentStep.duration
      ? Math.max(0, Math.min(1, p.distanceToNextManeuver / currentStep.distance)) *
        currentStep.duration
      : 0;
  const parsed = carTripProjectionSchema.safeParse({
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    maneuverId: `${snapshot.sessionId}:${p.currentStepIndex + 1}`,
    instruction: (
      step?.instruction || (snapshot.locale === "de" ? "Weiterfahren" : "Continue")
    ).slice(0, 1024),
    maneuverIcon: maneuverIconName(m) satisfies GuidanceIconName,
    // Like the phone's banner: lanes appear once the maneuver is close enough to act on.
    lanes:
      shownLanes && m
        ? presentGuidanceLanes(shownLanes, m, {
            sign: step?.sign as ManeuverSign | undefined,
          }).map((cell) => ({
            valid: cell.valid,
            arrows: cell.arrows.map(({ icon, active, stemShift }) => ({ icon, active, stemShift })),
          }))
        : undefined,
    ...(roundabout
      ? {
          roundabout: {
            exit: Math.min(99, Math.max(1, Math.trunc(step?.roundaboutExitCount ?? 1))),
            // Left-hand traffic circles clockwise.
            clockwise: step?.drivingSide === "left",
          },
        }
      : {}),
    distanceToManeuver: p.distanceToNextManeuver,
    maneuverDistance: measurementDistanceParts(p.distanceToNextManeuver, snapshot.units),
    remainingDistanceDisplay: measurementDistanceParts(p.distanceRemaining, snapshot.units),
    secondsToManeuver,
    maneuverEtaMs: now + secondsToManeuver * 1000,
    remainingDistance: p.distanceRemaining,
    remainingSeconds: Math.ceil(p.durationRemaining),
    etaMs: now + p.durationRemaining * 1000,
    rerouting: reroute.success && ["pending", "in-flight"].includes(reroute.data.status),
    locale: snapshot.locale,
    units: snapshot.units,
  });
  return parsed.success ? parsed.data : null;
}
