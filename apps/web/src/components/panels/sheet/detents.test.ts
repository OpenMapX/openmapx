import { describe, expect, it } from "vitest";
import {
  DIRECTIONS_DETENTS,
  detentFromSnapIndex,
  detentIndex,
  PLACE_DETENTS,
  snapSlots,
} from "./detents";

describe("snapSlots", () => {
  // Largest first: the library reverses the slot's assigned elements, so the
  // `top` class has to sit on the first snap in the DOM.
  it("emits the snaps largest first with the top class on the first", () => {
    expect(snapSlots(PLACE_DETENTS, 180)).toEqual([
      { snap: "100%", className: "top", detent: "top" },
      { snap: "52dvh", className: "initial", detent: "mid" },
      { snap: "min(180px, 52dvh)", detent: "peek" },
    ]);
  });

  it("always marks the first snap as the top snap", () => {
    for (const px of [null, 0, 240]) {
      expect(snapSlots(PLACE_DETENTS, px)[0]).toEqual({
        snap: "100%",
        className: "top",
        detent: "top",
      });
    }
  });

  it("falls back to a fixed peek before the content has been measured", () => {
    expect(snapSlots(PLACE_DETENTS, null).at(-1)).toEqual({ snap: "180px", detent: "peek" });
  });

  it("marks exactly one snap as the initial one", () => {
    const initial = snapSlots(PLACE_DETENTS, 180).filter((s) => s.className === "initial");
    expect(initial).toEqual([{ snap: "52dvh", className: "initial", detent: "mid" }]);
  });

  // The ceiling is the surface's own mid detent, so peek can never meet or
  // overtake it — a fixed fraction would invert the two on a surface whose mid
  // sits below that fraction.
  it("clamps a large measured peek below the middle detent", () => {
    expect(snapSlots(PLACE_DETENTS, 2400).at(-1)).toEqual({
      snap: "min(2400px, 52dvh)",
      detent: "peek",
    });
    expect(snapSlots(DIRECTIONS_DETENTS, 2400).at(-1)).toEqual({
      snap: "min(2400px, 42dvh)",
      detent: "peek",
    });
  });

  // Each marker's `detent` identity stays fixed across a remeasure — only the
  // `snap` length changes — so a React key built from it never remounts the
  // marker the browser is currently snapped to.
  it("keeps each slot's detent identity stable as the measured peek changes", () => {
    for (const px of [null, 96, 2400]) {
      expect(snapSlots(PLACE_DETENTS, px).map((s) => s.detent)).toEqual(["top", "mid", "peek"]);
    }
  });

  describe("without a mid detent", () => {
    const TWO_SNAP = { peek: "96px", maxHeight: "480px", initial: "peek" as const };

    it("emits exactly two snaps, top and peek", () => {
      expect(snapSlots(TWO_SNAP, null)).toEqual([
        { snap: "100%", className: "top", detent: "top" },
        { snap: "96px", className: "initial", detent: "peek" },
      ]);
    });

    // No mid to clamp against, so a content measurement is used as-is.
    it("uses a measured peek unclamped", () => {
      expect(snapSlots(TWO_SNAP, 120).at(-1)).toEqual({
        snap: "120px",
        className: "initial",
        detent: "peek",
      });
    });
  });
});

describe("detentIndex", () => {
  // Indices count from the bottom up, because the library reverses the slots.
  // Pin the literals: asserting only detentFromSnapIndex(detentIndex(x).y)
  // would pass just as happily against an inverted numbering.
  it("numbers a three-snap config from the bottom up", () => {
    expect(detentIndex(PLACE_DETENTS)).toEqual({ peek: 1, mid: 2, full: 3 });
  });

  it("numbers a two-snap config straight from peek to full", () => {
    const twoSnap = { peek: "96px", maxHeight: "480px", initial: "peek" as const };
    expect(detentIndex(twoSnap)).toEqual({ peek: 1, mid: undefined, full: 2 });
  });
});

describe("detentFromSnapIndex", () => {
  it("maps the library's snap indices onto detents", () => {
    expect(detentFromSnapIndex(1, PLACE_DETENTS)).toBe("peek");
    expect(detentFromSnapIndex(2, PLACE_DETENTS)).toBe("mid");
    expect(detentFromSnapIndex(3, PLACE_DETENTS)).toBe("full");
  });

  // Index 0 is the library's dismissed position. The sheet is non-dismissable,
  // so it should never occur — treat it as peek rather than crashing.
  it("treats the dismissed index as peek", () => {
    expect(detentFromSnapIndex(0, PLACE_DETENTS)).toBe("peek");
  });

  it("clamps indices above the top snap to full", () => {
    expect(detentFromSnapIndex(99, PLACE_DETENTS)).toBe("full");
  });

  it("skips mid for a two-snap config", () => {
    const twoSnap = { peek: "96px", maxHeight: "480px", initial: "peek" as const };
    expect(detentFromSnapIndex(1, twoSnap)).toBe("peek");
    expect(detentFromSnapIndex(2, twoSnap)).toBe("full");
    expect(detentFromSnapIndex(99, twoSnap)).toBe("full");
  });
});
