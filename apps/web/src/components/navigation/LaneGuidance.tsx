"use client";

import Box from "@mui/material/Box";
import { type ManeuverLane, resolveRecommendedLanes } from "@openmapx/core";
import {
  laneArrowStemShiftEm,
  laneIndicationIcon,
  type Maneuver,
  normalizeLaneToken,
} from "@/lib/navigation/maneuverIcon";

/**
 * Turn-lane guidance: one cell per lane, with an overlaid arrow for each allowed
 * indication. Lanes you may take are highlighted; the recommended arrow (the
 * engine's active indication, or the sole arrow of a single-option valid lane)
 * is drawn brightest, other arrows mid, and arrows in lanes you must not take
 * are dimmed. A lane with no real indication (`none`) renders as a blank cell.
 */
export function LaneGuidance({
  lanes,
  maneuver,
  variant = "standalone",
}: {
  lanes?: ManeuverLane[];
  maneuver?: Maneuver;
  /**
   * "standalone" = its own light card. "banner" = embedded in the maneuver
   * banner's darkened sub-row: transparent, white arrows keyed by opacity.
   */
  variant?: "standalone" | "banner";
}) {
  // Trust the engine's valid/active lanes; otherwise recommend them from the
  // maneuver (exact → same-side → unrestricted) so under-tagged lanes still light up.
  const resolved = resolveRecommendedLanes(lanes, maneuver);
  if (resolved.length === 0) return null;
  const banner = variant === "banner";
  const cell = banner ? 38 : 36;
  const arrowSize = banner ? 32 : 30;
  return (
    <Box
      sx={{
        display: "flex",
        gap: 0.5,
        justifyContent: "center",
        ...(banner ? { flex: 1 } : { p: 1, bgcolor: "background.paper", borderRadius: 2 }),
      }}
    >
      {resolved.map((lane, i) => {
        const arrows = lane.indications
          .map((ind) => ({ ind, icon: laneIndicationIcon(ind) }))
          .filter((a): a is { ind: string; icon: NonNullable<typeof a.icon> } => a.icon !== null);
        const activeNorm = lane.active ? normalizeLaneToken(lane.active) : null;
        return (
          <Box
            // biome-ignore lint/suspicious/noArrayIndexKey: lanes have no stable id
            key={i}
            data-valid={String(lane.valid)}
            data-arrow-count={String(arrows.length)}
            sx={{
              position: "relative",
              width: cell,
              height: cell,
              borderRadius: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: lane.valid
                ? banner
                  ? "rgba(255, 255, 255, 0.16)"
                  : "action.selected"
                : "transparent",
            }}
          >
            {arrows.length === 0 ? (
              <Box
                data-empty="true"
                sx={{
                  width: 12,
                  height: 2,
                  borderRadius: 1,
                  bgcolor: banner ? "rgba(255, 255, 255, 0.5)" : "text.disabled",
                }}
              />
            ) : (
              arrows.map(({ ind, icon }) => {
                const Icon = icon.component;
                const isActive =
                  lane.valid &&
                  (activeNorm ? normalizeLaneToken(ind) === activeNorm : arrows.length === 1);
                // Align the stems of a multi-indication lane onto one line so
                // only the tips diverge; a lone arrow stays centered as drawn.
                const stemShift = arrows.length > 1 ? laneArrowStemShiftEm(icon.name) : 0;
                return (
                  <Icon
                    key={ind}
                    data-active={String(isActive)}
                    sx={{
                      position: "absolute",
                      fontSize: arrowSize,
                      // On the dark banner the arrows are white throughout; state
                      // reads from opacity. Standalone keeps the tinted palette.
                      color: banner
                        ? "primary.contrastText"
                        : !lane.valid
                          ? "text.disabled"
                          : isActive
                            ? "primary.main"
                            : "text.primary",
                      opacity: banner
                        ? lane.valid
                          ? isActive
                            ? 1
                            : 0.6
                          : 0.35
                        : lane.valid
                          ? isActive
                            ? 1
                            : 0.55
                          : 0.3,
                      transform: stemShift ? `translateX(${stemShift}em)` : undefined,
                    }}
                  />
                );
              })
            )}
          </Box>
        );
      })}
    </Box>
  );
}
