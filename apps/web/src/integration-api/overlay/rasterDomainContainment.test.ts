import { expect, it } from "vitest";
import { prepareRasterContainment } from "./rasterDomainContainment";

const ring = (
  a: number,
  b: number,
  c: number,
  d: number,
): import("./nativeRasterCoverage").Ring => [
  [a, b],
  [c, b],
  [c, d],
  [a, d],
  [a, b],
];
it("certifies only rectangles contained in the exact orthogonal union, including holes and disconnected islands", () => {
  const contains = prepareRasterContainment([
    [ring(0, 0, 10, 10), ring(4, 4, 6, 6)],
    [ring(20, 0, 30, 10)],
  ]);
  expect(contains([1, 1, 3, 9])).toBe(true);
  expect(contains([0, 0, 4, 10])).toBe(true);
  expect(contains([1, 1, 9, 9])).toBe(false);
  expect(contains([4.5, 4.5, 5.5, 5.5])).toBe(false);
  expect(contains([9, 1, 21, 9])).toBe(false);
  expect(contains([21, 1, 29, 9])).toBe(true);
});
it("never certifies a concave gap or unsupported nonorthogonal boundary", () => {
  const contains = prepareRasterContainment([
    [
      [
        [0, 0],
        [10, 0],
        [10, 4],
        [4, 4],
        [4, 6],
        [10, 6],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ],
  ]);
  expect(contains([1, 1, 9, 9])).toBe(false);
  expect(contains([1, 1, 3, 9])).toBe(true);
  expect(
    prepareRasterContainment([
      [
        [
          [0, 0],
          [10, 0],
          [5, 10],
          [0, 0],
        ],
      ],
    ])([4, 1, 6, 2]),
  ).toBe(false);
});

import { difference, union } from "polyclip-ts";

it("agrees with independent polygon subtraction over deterministic fragmented dyadic unions", () => {
  const cells: import("./nativeRasterCoverage").MultiPolygon[] = [];
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++)
      if ((x * 7 + y * 3) % 5 !== 0) cells.push([[ring(x, y, x + 1, y + 1)]]);
  const mask = union(cells[0], ...cells.slice(1));
  const contains = prepareRasterContainment(mask);
  for (let x = 0; x < 7; x++)
    for (let y = 0; y < 7; y++)
      for (const size of [0.5, 1, 1.5]) {
        const r = [x + 0.25, y + 0.25, x + 0.25 + size, y + 0.25 + size] as const;
        expect(contains(r)).toBe(difference([[ring(...r)]], mask).length === 0);
      }
});
