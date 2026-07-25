import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { detentFromSnapEvent, useMobileSheet } from "./sheetState";

describe("detentFromSnapEvent", () => {
  it("maps the library payload onto a detent", () => {
    expect(detentFromSnapEvent({ sheetState: "partially-expanded", snapIndex: 2 })).toEqual({
      detent: "mid",
      isExpanded: false,
    });
  });

  it("reports expanded from sheetState, not from the index", () => {
    // Short content resolves `expanded` below the top snap index, and that is
    // when the content scroller unlocks — so sheetState is the authority.
    expect(detentFromSnapEvent({ sheetState: "expanded", snapIndex: 2 })).toEqual({
      detent: "mid",
      isExpanded: true,
    });
  });

  it("treats the collapsed position as peek", () => {
    expect(detentFromSnapEvent({ sheetState: "collapsed", snapIndex: 0 })).toEqual({
      detent: "peek",
      isExpanded: false,
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
