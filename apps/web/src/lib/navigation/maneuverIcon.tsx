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
import {
  type GuidanceIconName,
  laneArrowStemShift,
  laneIndicationIconName,
  maneuverIconName,
  normalizeLaneToken,
  unmarkedLaneIconName,
} from "@openmapx/core/navigation";

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

export { normalizeLaneToken };

/** Horizontal stem shift, in `em` (icon glyphs scale with font-size). */
export function laneArrowStemShiftEm(iconName: string): number {
  return laneArrowStemShift(iconName as GuidanceIconName);
}

/** Resolve a normalized maneuver to an MUI icon component. Falls back to Straight. */
export function maneuverIconFor(maneuver: Maneuver | undefined): ResolvedIcon {
  return resolved(maneuverIconName(maneuver));
}

/** The arrow for an unmarked lane the engine says serves the maneuver, if any. */
export function unmarkedLaneIcon(maneuver: Maneuver | undefined): ResolvedIcon | null {
  const name = unmarkedLaneIconName(maneuver);
  return name ? resolved(name) : null;
}

/** A lane indication token's icon; `null` for an empty `none` lane. */
export function laneIndicationIcon(indication: string): ResolvedIcon | null {
  const name = laneIndicationIconName(indication);
  return name ? resolved(name) : null;
}
