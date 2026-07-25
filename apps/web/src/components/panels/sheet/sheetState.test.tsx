import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DIRECTIONS_DETENTS, PLACE_DETENTS } from "./detents";
import { detentFromSnapEvent, useMobileSheet } from "./sheetState";

describe("detentFromSnapEvent", () => {
  it("maps the library payload onto a detent", () => {
    expect(
      detentFromSnapEvent({ sheetState: "partially-expanded", snapIndex: 2 }, PLACE_DETENTS),
    ).toEqual({
      detent: "mid",
      isExpanded: false,
    });
  });

  it("reports expanded from sheetState, not from the index", () => {
    // Short content resolves `expanded` below the top snap index, and that is
    // when the content scroller unlocks — so sheetState is the authority.
    expect(detentFromSnapEvent({ sheetState: "expanded", snapIndex: 2 }, PLACE_DETENTS)).toEqual({
      detent: "mid",
      isExpanded: true,
    });
  });

  it("treats the collapsed position as peek", () => {
    expect(detentFromSnapEvent({ sheetState: "collapsed", snapIndex: 0 }, PLACE_DETENTS)).toEqual({
      detent: "peek",
      isExpanded: false,
    });
  });

  it("numbers straight from peek to full for a two-snap config", () => {
    const twoSnap = { ...DIRECTIONS_DETENTS, mid: undefined };
    expect(
      detentFromSnapEvent({ sheetState: "partially-expanded", snapIndex: 1 }, twoSnap),
    ).toEqual({
      detent: "peek",
      isExpanded: false,
    });
    expect(detentFromSnapEvent({ sheetState: "expanded", snapIndex: 2 }, twoSnap)).toEqual({
      detent: "full",
      isExpanded: true,
    });
  });
});

describe("useMobileSheet outside a sheet", () => {
  it("reports a fully expanded sheet and a no-op snapTo", () => {
    const { result } = renderHook(() => useMobileSheet());
    expect(result.current.detent).toBe("full");
    expect(result.current.isExpanded).toBe(true);
    expect(() => result.current.snapTo("peek")).not.toThrow();
  });
});
