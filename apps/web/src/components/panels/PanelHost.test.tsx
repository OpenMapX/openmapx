import { PANEL, useNavigationStore, useSidebarStore } from "@openmapx/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";

const isMobileRef = { current: false };
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => isMobileRef.current }));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ getWithPanel: () => [] }),
}));
vi.mock("./panel-map", () => ({
  SIDEBAR_PANELS: {
    place: { component: () => <div>Docked place content</div> },
    category: { component: () => <div>Category results content</div> },
  },
  DETAIL_PANELS: {
    "place-card": () => <div>Floating place content</div>,
  },
}));
vi.mock("./sheet/MobileBottomSheet", () => ({
  MobileBottomSheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { PanelHost } from "./PanelHost";

afterEach(() => {
  useNavigationStore.setState({ status: "idle" });
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  publishMapObstruction("sidebar", "left", null);
  publishMapObstruction("detail", "left", null);
  isMobileRef.current = false;
});

describe("PanelHost desktop place shells", () => {
  it("renders one full-width docked rail for a standalone place", async () => {
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    const { container } = render(<PanelHost />);

    expect(await screen.findByText("Docked place content")).toBeInTheDocument();
    expect(screen.queryByText("Floating place content")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".MuiPaper-root")).toHaveLength(1);
    expect(getMapObstructionInsets().left).toBe(400);
  });

  it("renders the floating card beside a visible category rail and hides it on collapse", async () => {
    useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    const { container } = render(<PanelHost />);

    expect(await screen.findByText("Category results content")).toBeInTheDocument();
    expect(await screen.findByText("Floating place content")).toBeInTheDocument();
    expect(container.querySelectorAll(".MuiPaper-root")).toHaveLength(2);
    expect(getMapObstructionInsets().left).toBe(800);

    act(() => useSidebarStore.getState().setCollapsed(true));
    expect(screen.queryByText("Floating place content")).not.toBeInTheDocument();
    expect(getMapObstructionInsets().left).toBe(0);
    act(() => useSidebarStore.getState().setCollapsed(false));
    expect(screen.getByText("Floating place content")).toBeInTheDocument();
    expect(getMapObstructionInsets().left).toBe(800);
  });
});

it("keeps the place sheet available on mobile when a desktop rail was collapsed", async () => {
  isMobileRef.current = true;
  useSidebarStore.setState({
    activeSidebarId: PANEL.CATEGORY,
    activeDetailId: PANEL.PLACE_CARD,
    collapsed: true,
  });
  render(<PanelHost />);

  expect(await screen.findByText("Category results content")).toBeInTheDocument();
  expect(await screen.findByText("Floating place content")).toBeInTheDocument();
});

describe("PanelHost during navigation", () => {
  it.each([false, true])(
    "shows a place card opened mid-route but not the sidebar (mobile: %s)",
    async (mobile) => {
      isMobileRef.current = mobile;
      useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
      useNavigationStore.setState({ status: "navigating" });
      render(<PanelHost />);

      act(() => useSidebarStore.getState().openDetail(PANEL.PLACE_CARD));
      expect(await screen.findByText("Floating place content")).toBeInTheDocument();
      expect(screen.queryByText("Category results content")).not.toBeInTheDocument();
      // The guidance camera keeps its own framing.
      expect(getMapObstructionInsets().left).toBe(0);
    },
  );

  it("closes a card left open from planning when navigation starts", () => {
    useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    render(<PanelHost />);

    act(() => useNavigationStore.setState({ status: "navigating" }));
    expect(useSidebarStore.getState().activeDetailId).toBeNull();
    expect(screen.queryByText("Floating place content")).not.toBeInTheDocument();
  });

  it("hands a card opened mid-route back to the normal layout when guidance ends", async () => {
    useNavigationStore.setState({ status: "navigating" });
    render(<PanelHost />);
    act(() => useSidebarStore.setState({ activeDetailId: PANEL.PLACE_CARD }));

    act(() => useNavigationStore.setState({ status: "idle" }));
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
    expect(useSidebarStore.getState().activeDetailId).toBeNull();
    expect(await screen.findByText("Docked place content")).toBeInTheDocument();
  });
});
