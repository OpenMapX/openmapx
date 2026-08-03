import { describe, expect, it } from "vitest";
import { isPanelShiftActive, shouldHideLayerSelector } from "./layout";

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

describe("shouldHideLayerSelector", () => {
  it("keeps the selector visible beside any expanded desktop sidebar", () => {
    expect(
      shouldHideLayerSelector({
        desktop: true,
        detailOpen: false,
        sidebarOpen: true,
        selectedPlace: true,
      }),
    ).toBe(false);
  });

  it("hides the selector when a detail card is open on desktop", () => {
    expect(
      shouldHideLayerSelector({
        desktop: true,
        detailOpen: true,
        sidebarOpen: true,
        selectedPlace: true,
      }),
    ).toBe(true);
  });

  it("keeps mobile bottom-sheet avoidance for a selected place", () => {
    expect(
      shouldHideLayerSelector({
        desktop: false,
        detailOpen: false,
        sidebarOpen: true,
        selectedPlace: true,
      }),
    ).toBe(true);
  });

  it("does not hide mobile chrome for an expanded sidebar without a place", () => {
    expect(
      shouldHideLayerSelector({
        desktop: false,
        detailOpen: false,
        sidebarOpen: true,
        selectedPlace: false,
      }),
    ).toBe(false);
  });

  it("does not hide the selector when no panel is open", () => {
    expect(
      shouldHideLayerSelector({
        desktop: true,
        detailOpen: false,
        sidebarOpen: false,
        selectedPlace: false,
      }),
    ).toBe(false);
  });
});
