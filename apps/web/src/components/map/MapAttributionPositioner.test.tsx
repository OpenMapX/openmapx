import { describe, expect, it } from "vitest";
import { PANEL_WIDTH } from "@/lib/layout";
import { attribShiftPx } from "./MapAttributionPositioner";

describe("attribShiftPx", () => {
  it("shifts by the panel width when the sidebar is open and expanded", () => {
    expect(attribShiftPx({ sidebarOpen: true, sidebarCollapsed: false, navigating: false })).toBe(
      `${PANEL_WIDTH}px`,
    );
  });

  it("does not shift while navigating — the sidebar is hidden during turn-by-turn", () => {
    // Regression: shifting by PANEL_WIDTH on a narrow phone pushed the
    // attribution control's max-width negative, crushing it into the corner.
    expect(attribShiftPx({ sidebarOpen: true, sidebarCollapsed: false, navigating: true })).toBe(
      "0px",
    );
  });

  it("does not shift when the sidebar is closed or collapsed", () => {
    expect(attribShiftPx({ sidebarOpen: false, sidebarCollapsed: false, navigating: false })).toBe(
      "0px",
    );
    expect(attribShiftPx({ sidebarOpen: true, sidebarCollapsed: true, navigating: false })).toBe(
      "0px",
    );
  });
});
