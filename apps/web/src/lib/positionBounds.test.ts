import { expect, it } from "vitest";
import { positionBounds } from "./positionBounds";

it("spans every complete position, ignoring altitude", () => {
  expect(
    positionBounds([
      [6.6, 51.3, 120],
      [6.9, 51.1],
      [6.7, 51.2],
    ]),
  ).toEqual({ west: 6.6, south: 51.1, east: 6.9, north: 51.3 });
});

it("skips a position without both coordinates", () => {
  expect(positionBounds([[], [7], [6.6, 51.1], [6.8, 51.3]])).toEqual({
    west: 6.6,
    south: 51.1,
    east: 6.8,
    north: 51.3,
  });
});

it("is null without a complete position", () => {
  expect(positionBounds([])).toBeNull();
  expect(positionBounds([[7]])).toBeNull();
});
