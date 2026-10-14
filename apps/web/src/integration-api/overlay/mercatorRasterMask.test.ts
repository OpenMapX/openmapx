import { union } from "polyclip-ts";
import { expect, it } from "vitest";
import frame from "./fixtures/mercator-pitched-frame.json";
import { projectMercatorMask, retainedTileDomain } from "./mercatorRasterMask";

it("projects the actual pitch60/bearing40/wrapped-world retained frame without screen-space seam holes", () => {
  const masks = frame.tiles.map(retainedTileDomain);
  const merged = union(masks[0], ...masks.slice(1));
  const projected = projectMercatorMask(
    merged,
    frame.matrix,
    frame.wrap,
    frame.width,
    frame.height,
  );
  expect(projected).toHaveLength(1);
  expect(projected![0]).toHaveLength(1); // no artificial internal cracks
  expect(projected![0][0].every((p) => p.every(Number.isFinite))).toBe(true);
});
it("projects the actual wrapped world copy without canonicalizing it away", () => {
  const domain = retainedTileDomain({ wrap: 1, canonical: { z: 0, x: 0, y: 0 } });
  const projected = projectMercatorMask(
    domain,
    [2 / 8192, 0, 0, 0, 0, 2 / 8192, 0, 0, 0, 0, 1, 0, -1, -1, 0, 1],
    1,
    100,
    100,
  );
  expect(projected).toEqual([
    [
      [
        [0, 100],
        [100, 100],
        [100, 0],
        [0, 0],
        [0, 100],
      ],
    ],
  ]);
});
