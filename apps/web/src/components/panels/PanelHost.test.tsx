import { PANEL, useSidebarStore } from "@openmapx/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";

const isMobileRef = { current: false };
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => isMobileRef.current }));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ getWithPanel: () => [] }),
}));
vi.mock("@/components/navigation/HideDuringNavigation", () => ({
  HideDuringNavigation: ({ children }: { children: React.ReactNode }) => children,
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
