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
import { createSvgIcon } from "@mui/material/utils";
import {
  type GuidanceIconName,
  maneuverIconName,
  type RoundaboutStep,
  type RoundaboutTurn,
  roundaboutGlyph,
  roundaboutTurnAt,
} from "@openmapx/core/navigation";

export interface Maneuver {
  type: string;
  modifier?: string;
  /** How a roundabout is driven, read from the steps around it (`stepManeuver`). */
  roundabout?: RoundaboutTurn;
}

/**
 * A step's maneuver, with a roundabout's circulation and exit angle read from
 * the steps around it, so its glyph circles the way traffic does there.
 */
export function stepManeuver(
  steps: readonly RoundaboutStep[],
  index: number,
): Maneuver | undefined {
  const maneuver = steps[index]?.maneuver;
  if (!maneuver) return undefined;
  const roundabout = roundaboutTurnAt(steps, index);
  return roundabout ? { ...maneuver, roundabout } : maneuver;
}

const roundaboutIcons = new Map<string, SvgIconComponent>();

/** The roundabout glyph as an icon component, one per turn so re-renders keep it mounted. */
function roundaboutIcon(turn: RoundaboutTurn): SvgIconComponent {
  const key = `${turn.circulation}:${turn.exitAngle}`;
  let icon = roundaboutIcons.get(key);
  if (!icon) {
    const glyph = roundaboutGlyph(turn);
    icon = createSvgIcon(
      <>
        {glyph.strokes.map(({ d, width, opacity }) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={width}
            strokeOpacity={opacity}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {glyph.fills.map((d) => (
          <path key={d} d={d} />
        ))}
      </>,
      `Roundabout${key}`,
    );
    roundaboutIcons.set(key, icon);
  }
  return icon;
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
  const name = maneuverIconName(maneuver);
  return maneuver?.roundabout
    ? { component: roundaboutIcon(maneuver.roundabout), name }
    : resolved(name);
}
