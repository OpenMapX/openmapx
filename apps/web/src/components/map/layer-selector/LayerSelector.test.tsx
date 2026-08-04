// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode, Ref } from "react";
import { useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LAYER_SELECTOR_OPEN_EVENT } from "@/components/command-palette/constants";

const mockState = {
  desktopDock: true,
  selectedPlace: null as object | null,
  sidebar: {
    activeSidebarId: null as string | null,
    activeDetailId: null as string | null,
    collapsed: true,
  },
};
const mockPopoverAction = { updatePosition: vi.fn() };

vi.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}));
vi.mock("@mui/material/useMediaQuery", () => ({
  default: () => mockState.desktopDock,
}));
vi.mock("@mui/material/Popover", () => ({
  default: ({
    action,
    anchorEl,
    children,
    open,
    slotProps,
  }: {
    action?: Ref<{ updatePosition(): void }>;
    anchorEl?: { getBoundingClientRect(): DOMRect } | HTMLElement | null;
    children: ReactNode;
    open: boolean;
    slotProps?: { paper?: { sx?: { transition?: string } } };
  }) => {
    useImperativeHandle(action, () => mockPopoverAction, []);
    const anchorRect = anchorEl?.getBoundingClientRect();
    return open ? (
      <div
        data-anchor-left={anchorRect?.left}
        data-paper-transition={slotProps?.paper?.sx?.transition}
        data-testid="layer-selector-popover"
      >
        {children}
      </div>
    ) : null;
  },
}));
vi.mock("@openmapx/core", () => ({
  useLayerStore: (sel: (s: unknown) => unknown) => sel({ activeLayer: "default" }),
  usePlaceStore: (sel: (s: unknown) => unknown) => sel({ selectedPlace: mockState.selectedPlace }),
  useSidebarStore: (sel: (s: unknown) => unknown) => sel(mockState.sidebar),
  useNavigationStore: (sel: (s: unknown) => unknown) => sel({ status: "idle" }),
}));
vi.mock("./DesktopQuickSelector", () => ({
  DesktopQuickSelector: ({ onMoreClick }: { onMoreClick: (e: unknown) => void }) => (
    <button type="button" onClick={onMoreClick}>
      more
    </button>
  ),
}));
vi.mock("./DesktopMorePanel", () => ({
  DesktopMorePanel: () => <div>map-details-panel</div>,
}));
vi.mock("./MobileLayerPanel", () => ({
  MobileLayerPanel: () => <div>mobile-panel</div>,
}));

import { LayerSelector } from "./LayerSelector";

const quickSelectorToggle = () => screen.getByLabelText("openLayers");
const quickSelectorOpen = () => quickSelectorToggle().getAttribute("aria-expanded") === "true";

beforeEach(() => {
  mockState.desktopDock = true;
  mockState.selectedPlace = null;
  mockState.sidebar = {
    activeSidebarId: null,
    activeDetailId: null,
    collapsed: true,
  };
  mockPopoverAction.updatePosition.mockClear();
});

describe("LayerSelector desktop dock", () => {
  it("collapses the quick selector when the full map-details panel opens", async () => {
    const user = userEvent.setup();
    render(<LayerSelector />);

    await user.hover(quickSelectorToggle());
    expect(quickSelectorOpen()).toBe(true);

    // Clicking "More" from inside the quick selector never triggers its
    // mouse-leave/blur heuristics, so the panel must close it explicitly.
    await user.click(screen.getByText("more"));

    expect(screen.getByText("map-details-panel")).toBeDefined();
    expect(quickSelectorOpen()).toBe(false);
  });

  it("keeps the quick selector closed while the panel is open", async () => {
    const user = userEvent.setup();
    render(<LayerSelector />);

    await user.hover(quickSelectorToggle());
    await user.click(screen.getByText("more"));
    await user.hover(quickSelectorToggle());

    expect(quickSelectorOpen()).toBe(false);
  });

  it("collapses the quick selector when the panel is opened programmatically", async () => {
    const user = userEvent.setup();
    render(<LayerSelector />);

    await user.hover(quickSelectorToggle());
    expect(quickSelectorOpen()).toBe(true);

    window.dispatchEvent(new Event(LAYER_SELECTOR_OPEN_EVENT));

    expect(await screen.findByText("map-details-panel")).toBeDefined();
    expect(quickSelectorOpen()).toBe(false);
  });

  it("keeps the desktop dock visible when an expanded sidebar has a selected place", () => {
    mockState.sidebar = {
      activeSidebarId: "place",
      activeDetailId: null,
      collapsed: false,
    };
    mockState.selectedPlace = {};

    render(<LayerSelector />);

    expect(screen.getByLabelText("openLayers")).toBeDefined();
  });

  it("hides the desktop dock when an actual detail card is open", () => {
    mockState.sidebar = {
      activeSidebarId: "directions",
      activeDetailId: "place-card",
      collapsed: false,
    };
    mockState.selectedPlace = {};

    render(<LayerSelector />);

    expect(screen.queryByLabelText("openLayers")).toBeNull();
  });

  it("keeps mobile bottom-sheet avoidance for a selected place in a sidebar", () => {
    mockState.desktopDock = false;
    mockState.sidebar = {
      activeSidebarId: "place",
      activeDetailId: null,
      collapsed: false,
    };
    mockState.selectedPlace = {};

    render(<LayerSelector />);

    expect(screen.queryByLabelText("openLayerMenu")).toBeNull();
  });

  it("keeps the mobile layer button visible when the sidebar has no selected place", () => {
    mockState.desktopDock = false;
    mockState.sidebar = {
      activeSidebarId: "directions",
      activeDetailId: null,
      collapsed: false,
    };

    render(<LayerSelector />);

    expect(screen.getByLabelText("openLayerMenu")).toBeDefined();
  });

  it("moves an open layer panel with the sidebar offset transition", async () => {
    const user = userEvent.setup();
    mockState.sidebar = {
      activeSidebarId: "directions",
      activeDetailId: null,
      collapsed: false,
    };
    const { rerender } = render(<LayerSelector />);

    await user.hover(quickSelectorToggle());
    await user.click(screen.getByText("more"));
    const popover = screen.getByTestId("layer-selector-popover");
    expect(popover).toBeDefined();
    expect(popover.getAttribute("data-anchor-left")).toBe("400");
    mockPopoverAction.updatePosition.mockClear();

    mockState.sidebar = {
      activeSidebarId: null,
      activeDetailId: null,
      collapsed: false,
    };
    rerender(<LayerSelector />);

    expect(mockPopoverAction.updatePosition).toHaveBeenCalledTimes(1);
    const movedPopover = screen.getByTestId("layer-selector-popover");
    expect(movedPopover.getAttribute("data-anchor-left")).toBe("0");
    expect(movedPopover.getAttribute("data-paper-transition")).toBe(
      "left 0.25s ease, opacity 0.18s ease, transform 0.16s ease !important",
    );
  });
});
