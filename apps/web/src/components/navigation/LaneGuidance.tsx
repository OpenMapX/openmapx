"use client";

import Box from "@mui/material/Box";
import type { LaneDestinations, ManeuverLane, ManeuverSign } from "@openmapx/core";
import { presentGuidanceLanes } from "@openmapx/core/navigation";
import { guidanceIconComponent, type Maneuver } from "@/lib/navigation/maneuverIcon";

/**
 * Turn-lane guidance: one cell per lane, with an overlaid arrow for each allowed
 * indication. Lanes you may take are highlighted; the recommended arrow (the
 * engine's active indication, or the sole arrow of a single-option valid lane)
 * is drawn brightest, other arrows mid, and arrows in lanes you must not take
 * are dimmed. A lane with no real indication (`none`) renders as a blank cell,
 * unless the engine chose it for this maneuver: an unmarked lane the engine
 * sends you down then carries the maneuver's own arrow.
 */
export function LaneGuidance({
  lanes,
  maneuver,
  sign,
  laneDestinations,
  source = "engine",
  variant = "standalone",
  size = "regular",
}: {
  lanes?: ManeuverLane[];
  maneuver?: Maneuver;
  /** The maneuver's signage, matched against `laneDestinations`. */
  sign?: ManeuverSign;
  /** OSM destinations per lane on the approach, when the junction lookup found them. */
  laneDestinations?: LaneDestinations[];
  /** Only engine-selected unmarked lanes may inherit the maneuver arrow. */
  source?: "engine" | "osm";
  /**
   * "standalone" = its own light card. "banner" = embedded in the maneuver
   * banner's darkened sub-row: transparent, white arrows keyed by opacity.
   */
  variant?: "standalone" | "banner";
  /** "compact" shrinks the cells for the directions list rows. */
  size?: "regular" | "compact";
}) {
  // Shared with the Android Auto routing card: which lanes light up and which arrow
  // in each is recommended (see `presentGuidanceLanes`).
  const cells = presentGuidanceLanes(lanes, maneuver, { sign, laneDestinations }, source);
  if (cells.length === 0) return null;
  const banner = variant === "banner";
  const cell = size === "compact" ? 28 : banner ? 38 : 36;
  const arrowSize = size === "compact" ? 24 : banner ? 32 : 30;
  return (
    <Box
      sx={{
        display: "flex",
        gap: 0.5,
        justifyContent: "center",
        ...(banner ? { flex: 1 } : { p: 1, bgcolor: "background.paper", borderRadius: 2 }),
      }}
    >
      {cells.map((lane, i) => {
        const arrows = lane.arrows;
        return (
          <Box
            // biome-ignore lint/suspicious/noArrayIndexKey: lanes have no stable id
            key={i}
            data-valid={String(lane.valid)}
            data-inferred={lane.inferred ? "true" : undefined}
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
              arrows.map(({ indication, icon, active: isActive, stemShift: shift }) => {
                const Icon = guidanceIconComponent(icon);
                // Stems of a multi-indication lane share one line; only the tips diverge.
                const stemShift = shift;
                return (
                  <Icon
                    key={indication}
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
