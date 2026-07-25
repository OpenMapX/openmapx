import { describe, expect, it } from "vitest";
import {
  DETENT_INDEX,
  DIRECTIONS_DETENTS,
  detentFromSnapIndex,
  PLACE_DETENTS,
  snapSlots,
} from "./detents";

describe("snapSlots", () => {
  // Largest first: the library reverses the slot's assigned elements, so the
  // `top` class has to sit on the first snap in the DOM.
  it("emits the snaps largest first with the top class on the first", () => {
    expect(snapSlots(PLACE_DETENTS, 180)).toEqual([
      { snap: "100%", className: "top" },
      { snap: "52dvh", className: "initial" },
      { snap: "min(180px, 52dvh)" },
    ]);
  });

  it("always marks the first snap as the top snap", () => {
    for (const px of [null, 0, 240]) {
      expect(snapSlots(PLACE_DETENTS, px)[0]).toEqual({ snap: "100%", className: "top" });
    }
  });

  it("falls back to a fixed peek before the content has been measured", () => {
    expect(snapSlots(PLACE_DETENTS, null).at(-1)).toEqual({ snap: "180px" });
  });

  it("marks exactly one snap as the initial one", () => {
    const initial = snapSlots(PLACE_DETENTS, 180).filter((s) => s.className === "initial");
    expect(initial).toEqual([{ snap: "52dvh", className: "initial" }]);
  });

  // The ceiling is the surface's own mid detent, so peek can never meet or
  // overtake it — a fixed fraction would invert the two on a surface whose mid
  // sits below that fraction.
  it("clamps a large measured peek below the middle detent", () => {
    expect(snapSlots(PLACE_DETENTS, 2400).at(-1)).toEqual({ snap: "min(2400px, 52dvh)" });
    expect(snapSlots(DIRECTIONS_DETENTS, 2400).at(-1)).toEqual({ snap: "min(2400px, 42dvh)" });
  });
});

describe("detentFromSnapIndex", () => {
  // Indices count from the bottom up, because the library reverses the slots.
  // Pin the literals: asserting only detentFromSnapIndex(DETENT_INDEX.x) would
  // pass just as happily against an inverted numbering.
  it("numbers the snaps from the bottom up", () => {
    expect(DETENT_INDEX).toEqual({ peek: 1, mid: 2, full: 3 });
  });

  it("maps the library's snap indices onto detents", () => {
    expect(detentFromSnapIndex(1)).toBe("peek");
    expect(detentFromSnapIndex(2)).toBe("mid");
    expect(detentFromSnapIndex(3)).toBe("full");
  });

  // Index 0 is the library's dismissed position. The sheet is non-dismissable,
  // so it should never occur — treat it as peek rather than crashing.
  it("treats the dismissed index as peek", () => {
    expect(detentFromSnapIndex(0)).toBe("peek");
  });

  it("clamps indices above the top snap to full", () => {
    expect(detentFromSnapIndex(99)).toBe("full");
  });
});
