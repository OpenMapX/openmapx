import { describe, expect, it } from "vitest";
import { isPanelShiftActive } from "./layout";

describe("isPanelShiftActive", () => {
  it("is active when the sidebar is open, expanded, and not navigating", () => {
    expect(
      isPanelShiftActive({ sidebarOpen: true, sidebarCollapsed: false, navigating: false }),
    ).toBe(true);
  });

  it("is not active while navigating — the panel is hidden during turn-by-turn", () => {
    // Regression: the legal footer stayed shifted right by PANEL_WIDTH during
    // navigation even though the directions panel is hidden, so it no longer
    // sat flush against the map's left edge.
    expect(
      isPanelShiftActive({ sidebarOpen: true, sidebarCollapsed: false, navigating: true }),
    ).toBe(false);
  });

  it("is not active when the sidebar is closed or collapsed", () => {
    expect(
      isPanelShiftActive({ sidebarOpen: false, sidebarCollapsed: false, navigating: false }),
    ).toBe(false);
    expect(
      isPanelShiftActive({ sidebarOpen: true, sidebarCollapsed: true, navigating: false }),
    ).toBe(false);
  });
});
