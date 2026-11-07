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
import type { GuidanceIconName } from "@openmapx/core/navigation";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { guidanceIconComponent, maneuverIconFor } from "./maneuverIcon";

const glyphs: Record<GuidanceIconName, SvgIconComponent> = {
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
const paths = (container: HTMLElement) =>
  [...container.querySelectorAll("svg")].map((svg) =>
    [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d")),
  );

it("binds shared glyphs and the maneuver adapter to actual MUI geometry", () => {
  const Resolved = maneuverIconFor({ type: "turn", modifier: "left" }).component;
  const actual = render(
    <>
      {Object.keys(glyphs).map((name) => {
        const Glyph = guidanceIconComponent(name as GuidanceIconName);
        return <Glyph key={name} />;
      })}
      <Resolved />
    </>,
  );
  const actualPaths = paths(actual.container);
  expect(actualPaths).toHaveLength(15);
  actual.unmount();
  const expected = render(
    <>
      {Object.entries(glyphs).map(([name, Glyph]) => (
        <Glyph key={name} />
      ))}
      <TurnLeft />
    </>,
  );
  expect(actualPaths).toEqual(paths(expected.container));
});
