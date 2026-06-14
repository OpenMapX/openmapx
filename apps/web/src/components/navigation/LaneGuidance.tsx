"use client";

import Box from "@mui/material/Box";
import { type ManeuverLane, resolveRecommendedLanes } from "@openmapx/core";
import {
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
export function LaneGuidance({ lanes, maneuver }: { lanes?: ManeuverLane[]; maneuver?: Maneuver }) {
  // Trust the engine's valid/active lanes; otherwise recommend them from the
  // maneuver (exact → same-side → unrestricted) so under-tagged lanes still light up.
  const resolved = resolveRecommendedLanes(lanes, maneuver?.modifier);
  if (resolved.length === 0) return null;
  return (
    <Box
      sx={{
        display: "flex",
        gap: 0.75,
        justifyContent: "center",
        p: 1,
        bgcolor: "background.paper",
        borderRadius: 2,
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
              width: 28,
              height: 28,
              borderRadius: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: lane.valid ? "action.selected" : "transparent",
            }}
          >
            {arrows.length === 0 ? (
              <Box
                data-empty="true"
                sx={{ width: 12, height: 2, borderRadius: 1, bgcolor: "text.disabled" }}
              />
            ) : (
              arrows.map(({ ind, icon }) => {
                const Icon = icon.component;
                const isActive =
                  lane.valid &&
                  (activeNorm ? normalizeLaneToken(ind) === activeNorm : arrows.length === 1);
                return (
                  <Icon
                    key={ind}
                    data-active={String(isActive)}
                    sx={{
                      position: "absolute",
                      fontSize: 22,
                      color: !lane.valid
                        ? "text.disabled"
                        : isActive
                          ? "primary.main"
                          : "text.primary",
                      opacity: lane.valid ? (isActive ? 1 : 0.55) : 0.3,
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
