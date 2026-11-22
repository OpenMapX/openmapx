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
import { type GuidanceIconName, roundaboutGlyph } from "@openmapx/core/navigation";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { guidanceIconComponent, maneuverIconFor, stepManeuver } from "./maneuverIcon";

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

it("draws a roundabout as the shared glyph for its circulation and exit", () => {
  const turn = { circulation: "ccw" as const, exitAngle: 90 };
  const { component: Glyph } = maneuverIconFor({ type: "roundabout", roundabout: turn });
  const { container } = render(<Glyph />);
  const glyph = roundaboutGlyph(turn);
  expect(paths(container)[0]).toEqual([...glyph.strokes.map(({ d }) => d), ...glyph.fills]);
  // One component per turn, so a banner re-render does not remount the icon.
  expect(maneuverIconFor({ type: "roundabout", roundabout: { ...turn } }).component).toBe(Glyph);
});

it("reads a step's roundabout turn from the steps around it", () => {
  const M = 1 / 111_195;
  const steps = [
    {
      maneuver: { type: "turn" },
      coordinates: [
        [0, -30 * M],
        [0, 0],
      ] as [number, number][],
    },
    {
      maneuver: { type: "roundabout" },
      bearingBefore: 0,
      coordinates: [0, 15, 30, 45, 60, 75, 90].map((deg): [number, number] => {
        const a = (deg * Math.PI) / 180;
        return [-(15 - 15 * Math.cos(a)) * M, 15 * Math.sin(a) * M];
      }),
    },
    { maneuver: { type: "exit roundabout" }, bearingAfter: 270, coordinates: [] },
  ];
  expect(stepManeuver(steps, 1)).toEqual({
    type: "roundabout",
    roundabout: { circulation: "ccw", exitAngle: 270 },
  });
  expect(stepManeuver(steps, 0)).toEqual({ type: "turn" });
  expect(stepManeuver(steps, 5)).toBeUndefined();
});
