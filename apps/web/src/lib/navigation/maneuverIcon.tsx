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

export interface Maneuver {
  type: string;
  modifier?: string;
}

interface ResolvedIcon {
  component: SvgIconComponent;
  name: string;
}

/**
 * Directional turn-arrow vocabulary shared by maneuver icons and lane
 * indications, keyed by normalized token (see {@link normalizeLaneToken}).
 *
 * Each `name` is the stable icon identifier (e.g. "TurnLeft") carried in the
 * table itself, not from MUI's reflective metadata: in the test/transpiled build
 * MUI's `muiName`/`displayName`/`name` are not preserved on the icon component,
 * so labelling each entry explicitly keeps `name` deterministic.
 */
const ARROW_ICONS: Record<string, ResolvedIcon> = {
  straight: { component: Straight, name: "Straight" },
  left: { component: TurnLeft, name: "TurnLeft" },
  right: { component: TurnRight, name: "TurnRight" },
  "slight left": { component: TurnSlightLeft, name: "TurnSlightLeft" },
  "slight right": { component: TurnSlightRight, name: "TurnSlightRight" },
  "sharp left": { component: TurnSharpLeft, name: "TurnSharpLeft" },
  "sharp right": { component: TurnSharpRight, name: "TurnSharpRight" },
  uturn: { component: UTurnLeft, name: "UTurnLeft" },
};

const MERGE_ICON: ResolvedIcon = { component: MergeType, name: "MergeType" };

/** Normalize a turn/lane token: trim, lowercase, and underscores → spaces. */
export function normalizeLaneToken(token: string): string {
  return token.trim().toLowerCase().replace(/_/g, " ");
}

/**
 * Resolve a normalized maneuver to an MUI icon component. Falls back to Straight.
 */
export function maneuverIconFor(maneuver: Maneuver | undefined): ResolvedIcon {
  const m = maneuver?.modifier ?? "";
  switch (maneuver?.type) {
    case "arrive":
      return { component: Flag, name: "Flag" };
    // OSRM uses `exit roundabout`/`exit rotary` for the leaving maneuver.
    case "roundabout":
    case "rotary":
    case "exit roundabout":
    case "exit rotary":
      return m.includes("left")
        ? { component: RoundaboutLeft, name: "RoundaboutLeft" }
        : { component: RoundaboutRight, name: "RoundaboutRight" };
    case "merge":
      return MERGE_ICON;
    // Staying on the current road is not taking a fork. Use a gentle diagonal
    // arrow for keep-left/right and a straight arrow for keep-straight.
    case "keep":
      if (m.includes("left")) return ARROW_ICONS["slight left"];
      if (m.includes("right")) return ARROW_ICONS["slight right"];
      return ARROW_ICONS.straight;
    // Forks and ramps both branch off the through road; OSRM emits `on ramp`/
    // `off ramp` (Valhalla ramps/exits are normalized to `fork`).
    case "fork":
    case "on ramp":
    case "off ramp":
      return m.includes("left")
        ? { component: ForkLeft, name: "ForkLeft" }
        : { component: ForkRight, name: "ForkRight" };
  }
  // `turn`, `end of road`, `continue`, `new name`, `roundabout turn`,
  // `notification`, `use lane`, `depart` → a directional arrow from the modifier.
  return ARROW_ICONS[normalizeLaneToken(m)] ?? ARROW_ICONS.straight;
}

/**
 * Resolve a single lane *indication* token to an MUI icon, covering the full
 * OSRM and Valhalla vocabularies (space- or underscore-separated; `through`≈
 * straight, `reverse`≈uturn). Returns `null` for an empty `none` lane so the UI
 * can render a blank cell. Unknown tokens fall back to a straight arrow.
 */
export function laneIndicationIcon(indication: string): ResolvedIcon | null {
  const token = normalizeLaneToken(indication);
  if (token === "" || token === "none") return null;
  if (token === "merge to left" || token === "merge to right") return MERGE_ICON;
  if (token === "through") return ARROW_ICONS.straight;
  if (token === "reverse") return ARROW_ICONS.uturn;
  return ARROW_ICONS[token] ?? ARROW_ICONS.straight;
}
