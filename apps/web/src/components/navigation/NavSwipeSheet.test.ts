import { expect, it } from "vitest";
import { navigationPeekFooterHeight } from "./NavSwipeSheet";

it("reserves docked map credits for a tall peek without depending on their current parent", () => {
  expect(navigationPeekFooterHeight(455, 640, 24, 78)).toBe(78);
  expect(navigationPeekFooterHeight(300, 640, 24, 78)).toBe(0);
});
it("reserves credits when a walking banner leaves too little map space", () => {
  expect(navigationPeekFooterHeight(300, 640, 280, 78)).toBe(78);
});
it("tolerates a fractional snap boundary and missing measurements", () => {
  expect(navigationPeekFooterHeight(416.5, 640, 0, 78)).toBe(0);
  expect(navigationPeekFooterHeight(455, 0, 0, 78)).toBe(0);
  expect(navigationPeekFooterHeight(455, 640, 0, 0)).toBe(0);
});
