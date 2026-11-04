import { z } from "zod";
import type { GroundFullSnapshot } from "../navigation/snapshots/groundSnapshot";

const nonnegative = z.number().finite().nonnegative();
export const carTripProjectionSchema = z.object({
  sessionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  maneuverId: z.string().max(256),
  instruction: z.string().min(1).max(1024),
  maneuver: z.enum([
    "straight",
    "left",
    "right",
    "slight-left",
    "slight-right",
    "keep-left",
    "keep-right",
    "sharp-left",
    "sharp-right",
    "uturn-left",
    "uturn-right",
    "roundabout",
    "roundabout-cw",
    "arrive",
  ]),
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
  exit: z.number().int().min(1).max(99).optional(),
  distanceToManeuver: nonnegative,
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
  maneuver: z
    .object({ type: z.string(), modifier: z.string().optional(), exit: z.number().optional() })
    .optional(),
});
const progressSchema = z.object({
  currentStepIndex: z.number().int().nonnegative(),
  distanceToNextManeuver: nonnegative,
  distanceRemaining: nonnegative,
  durationRemaining: nonnegative,
});

/** The maneuver is at the START of the next step, not the step being driven. */
export function buildCarTripProjection(
  snapshot: Pick<
    GroundFullSnapshot,
    "status" | "route" | "progress" | "reroute" | "locale" | "units" | "sessionId" | "revision"
  >,
  now: number,
): CarTripProjection | null {
  if (snapshot.status !== "active") return null;
  const route = z
    .object({
      steps: z.array(stepSchema),
      distance: nonnegative.optional(),
      duration: nonnegative.optional(),
    })
    .safeParse(snapshot.route);
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
  const step = route.data.steps[Math.min(p.currentStepIndex + 1, route.data.steps.length - 1)];
  const m = step?.maneuver;
  let maneuver: CarTripProjection["maneuver"] = "straight";
  if (m?.type === "arrive") maneuver = "arrive";
  else if (m?.type === "roundabout" || m?.type === "rotary")
    maneuver = step?.drivingSide === "left" ? "roundabout-cw" : "roundabout";
  else if (m?.modifier) {
    const mapped: Record<string, CarTripProjection["maneuver"]> = {
      left: "left",
      right: "right",
      "slight left": "slight-left",
      "slight right": "slight-right",
      "sharp left": "sharp-left",
      "sharp right": "sharp-right",
      uturn: "uturn-left",
    };
    maneuver = mapped[m.modifier] ?? "straight";
    // Keeping, forking, ramping or merging to one side is "keep left/right", not a turn.
    if (
      ["keep", "fork", "on ramp", "off ramp", "merge"].includes(m.type) &&
      (maneuver === "left" || maneuver === "slight-left")
    )
      maneuver = "keep-left";
    if (
      ["keep", "fork", "on ramp", "off ramp", "merge"].includes(m.type) &&
      (maneuver === "right" || maneuver === "slight-right")
    )
      maneuver = "keep-right";
  }
  const reroute = z.object({ status: z.string() }).safeParse(snapshot.reroute);
  const currentStep = route.data.steps[Math.max(0, p.currentStepIndex)];
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
    maneuver,
    lanes: step?.lanes,
    ...(maneuver.startsWith("roundabout")
      ? { exit: Math.min(99, Math.max(1, Math.trunc(step?.roundaboutExitCount ?? 1))) }
      : {}),
    distanceToManeuver: p.distanceToNextManeuver,
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
