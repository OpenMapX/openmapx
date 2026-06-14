import type { ManeuverLane } from "@integrations/routing/types";

/** Normalize a lane/turn token: trim, lowercase, underscores → spaces. */
function norm(token: string): string {
  return token.trim().toLowerCase().replace(/_/g, " ");
}

/** Mark a lane valid (and set its active indication) when one of its indications matches. */
function markIfMatch(lane: ManeuverLane, matches: (indication: string) => boolean): ManeuverLane {
  const hit = lane.indications.find((i) => matches(norm(i)));
  if (!hit) return { ...lane, valid: false };
  return { ...lane, valid: true, active: hit };
}

/**
 * Decide which lanes to highlight for an upcoming maneuver. When the routing
 * engine already marked a lane valid we trust it; otherwise we recommend lanes
 * ourselves from the maneuver modifier — exact match first ("left" → a left
 * lane), then the same side ("left" → a slight/sharp-left lane), then any
 * unrestricted lane. This mirrors OSMAnd's exact→approximate→unrestricted
 * fallback so under-tagged OSM lanes still light up. Pure.
 */
export function resolveRecommendedLanes(
  lanes: ManeuverLane[] | undefined,
  modifier: string | undefined,
): ManeuverLane[] {
  if (!lanes || lanes.length === 0) return lanes ?? [];
  if (lanes.some((l) => l.valid)) return lanes; // engine already decided

  const mod = modifier ? norm(modifier) : "";

  // Going straight (or no modifier): a through/straight/unmarked lane keeps you on-route.
  if (mod === "" || mod === "straight") {
    return lanes.map((l) =>
      markIfMatch(l, (i) => i === "through" || i === "straight" || i === "none" || i === ""),
    );
  }

  const exact = lanes.map((l) => markIfMatch(l, (i) => i === mod));
  if (exact.some((l) => l.valid)) return exact;

  const side = mod.includes("left") ? "left" : mod.includes("right") ? "right" : null;
  if (side) {
    const approx = lanes.map((l) => markIfMatch(l, (i) => i.includes(side)));
    if (approx.some((l) => l.valid)) return approx;
  }

  // Last resort: an unrestricted lane is usable for any maneuver.
  return lanes.map((l) => markIfMatch(l, (i) => i === "none" || i === ""));
}
