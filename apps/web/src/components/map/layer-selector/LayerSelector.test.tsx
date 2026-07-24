// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LAYER_SELECTOR_OPEN_EVENT } from "@/components/command-palette/constants";

vi.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}));
vi.mock("@mui/material/useMediaQuery", () => ({
  default: () => true,
}));
vi.mock("@openmapx/core", () => ({
  useCategorySearchStore: (sel: (s: unknown) => unknown) => sel({ activeCategory: null }),
  useLayerStore: (sel: (s: unknown) => unknown) => sel({ activeLayer: "default" }),
  usePlaceStore: (sel: (s: unknown) => unknown) => sel({ selectedPlace: null }),
  useSidebarStore: (sel: (s: unknown) => unknown) =>
    sel({ activeSidebarId: null, collapsed: true }),
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
});
