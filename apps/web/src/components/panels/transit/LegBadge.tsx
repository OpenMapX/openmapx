"use client";
import CommuteIcon from "@mui/icons-material/Commute";
import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { RouteBadge } from "./RouteBadge";

export function LegBadge({ leg }: { leg: TripLeg }) {
  if (leg.mode === "walking") {
    return <DirectionsWalkIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
  }
  if (leg.mode === "cycling") {
    return <DirectionsBikeIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
  }
  if (leg.mode === "driving") {
    return <DirectionsCarIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
  }
  if (leg.route) {
    return (
      <RouteBadge
        shortName={leg.route.shortName}
        color={leg.route.color}
        textColor={leg.route.textColor}
        mode={leg.mode}
        size="small"
      />
    );
  }
  const ModeIcon = leg.mode === "other" ? CommuteIcon : DirectionsBusIcon;
  return <ModeIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
}
