import type { SvgIconComponent } from "@mui/icons-material";
import Flag from "@mui/icons-material/Flag";
import ForkLeft from "@mui/icons-material/ForkLeft";
import ForkRight from "@mui/icons-material/ForkRight";
import MergeType from "@mui/icons-material/MergeType";
import RoundaboutLeft from "@mui/icons-material/RoundaboutLeft";
import RoundaboutRight from "@mui/icons-material/RoundaboutRight";
import Straight from "@mui/icons-material/Straight";
import TurnLeft from "@mui/icons-material/TurnLeft";
import TurnRight from "@mui/icons-material/TurnRight";
import TurnSharpLeft from "@mui/icons-material/TurnSharpLeft";
import TurnSharpRight from "@mui/icons-material/TurnSharpRight";
import TurnSlightLeft from "@mui/icons-material/TurnSlightLeft";
import TurnSlightRight from "@mui/icons-material/TurnSlightRight";
import UTurnLeft from "@mui/icons-material/UTurnLeft";

interface Maneuver {
  type: string;
  modifier?: string;
}

interface ResolvedIcon {
  component: SvgIconComponent;
  name: string;
}

/**
 * Resolve a normalized maneuver to an MUI icon component. Falls back to Straight.
 *
 * The returned `name` is the stable icon identifier (e.g. "TurnLeft") derived from
 * the mapping itself, not from MUI's reflective metadata: in the test/transpiled
 * build MUI's `muiName`/`displayName`/`name` are not preserved on the icon
 * component, so we label each branch explicitly to keep `name` deterministic.
 */
export function maneuverIconFor(maneuver: Maneuver | undefined): ResolvedIcon {
  const pick = (component: SvgIconComponent, name: string): ResolvedIcon => ({
    component,
    name,
  });

  const m = maneuver?.modifier ?? "";
  switch (maneuver?.type) {
    case "arrive":
      return pick(Flag, "Flag");
    case "roundabout":
    case "rotary":
      return m.includes("left")
        ? pick(RoundaboutLeft, "RoundaboutLeft")
        : pick(RoundaboutRight, "RoundaboutRight");
    case "merge":
      return pick(MergeType, "MergeType");
    case "fork":
      return m.includes("left") ? pick(ForkLeft, "ForkLeft") : pick(ForkRight, "ForkRight");
  }
  if (m === "uturn") return pick(UTurnLeft, "UTurnLeft");
  if (m === "sharp left") return pick(TurnSharpLeft, "TurnSharpLeft");
  if (m === "sharp right") return pick(TurnSharpRight, "TurnSharpRight");
  if (m === "slight left") return pick(TurnSlightLeft, "TurnSlightLeft");
  if (m === "slight right") return pick(TurnSlightRight, "TurnSlightRight");
  if (m === "left") return pick(TurnLeft, "TurnLeft");
  if (m === "right") return pick(TurnRight, "TurnRight");
  return pick(Straight, "Straight");
}
