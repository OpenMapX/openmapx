import type { SvgIconComponent } from "@mui/icons-material";
import Elevator from "@mui/icons-material/Elevator";
import Flag from "@mui/icons-material/Flag";
import MergeType from "@mui/icons-material/MergeType";
import RoundaboutLeft from "@mui/icons-material/RoundaboutLeft";
import RoundaboutRight from "@mui/icons-material/RoundaboutRight";
import Stairs from "@mui/icons-material/Stairs";
import Straight from "@mui/icons-material/Straight";
import TurnLeft from "@mui/icons-material/TurnLeft";
import TurnRight from "@mui/icons-material/TurnRight";
import TurnSharpLeft from "@mui/icons-material/TurnSharpLeft";
import TurnSharpRight from "@mui/icons-material/TurnSharpRight";
import TurnSlightLeft from "@mui/icons-material/TurnSlightLeft";
import TurnSlightRight from "@mui/icons-material/TurnSlightRight";
import UTurnLeft from "@mui/icons-material/UTurnLeft";
import { type GuidanceIconName, maneuverIconName } from "@openmapx/core/navigation";

export interface Maneuver {
  type: string;
  modifier?: string;
}

interface ResolvedIcon {
  component: SvgIconComponent;
  name: GuidanceIconName;
}

/**
 * The MUI component for each shared guidance glyph. Which glyph a maneuver or lane
 * shows is decided in `@openmapx/core` (`maneuverIconName`, `laneIndicationIconName`),
 * so the Android Auto car screen, which draws the same glyphs natively, matches.
 */
const ICONS: Record<GuidanceIconName, SvgIconComponent> = {
  Straight,
  TurnLeft,
  TurnRight,
  TurnSlightLeft,
  TurnSlightRight,
  TurnSharpLeft,
  TurnSharpRight,
  UTurnLeft,
  MergeType,
  RoundaboutLeft,
  RoundaboutRight,
  Flag,
  Stairs,
  Elevator,
};

const resolved = (name: GuidanceIconName): ResolvedIcon => ({ component: ICONS[name], name });

/** The MUI component that draws a shared guidance glyph. */
export function guidanceIconComponent(name: GuidanceIconName): SvgIconComponent {
  return ICONS[name];
}

/** Resolve a normalized maneuver to an MUI icon component. Falls back to Straight. */
export function maneuverIconFor(maneuver: Maneuver | undefined): ResolvedIcon {
  return resolved(maneuverIconName(maneuver));
}
