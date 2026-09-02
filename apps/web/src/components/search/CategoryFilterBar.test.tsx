import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import { createQueryWrapper, render } from "@/test";

const isMobileRef = { current: true };
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => isMobileRef.current }));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { useCategorySearchStore, useDataSourceStore } from "@openmapx/core";
import { CategoryFilterBar } from "./CategoryFilterBar";

// The measured registration observes its element, and jsdom ships no
// ResizeObserver — without this the hook falls back to its observer-less path
// and the tests would exercise something the browser never runs.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

/**
 * jsdom lays nothing out, so an unstubbed `getBoundingClientRect` reports an
 * all-zero box — and a zero extent is exactly how the registry spells "not on
 * screen". Every assertion here would then pass for the wrong reason.
 */
const BAR_BOTTOM = 56;

function stubLayout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    top: 20,
    bottom: BAR_BOTTOM,
    left: 0,
    right: 320,
    width: 320,
    height: 36,
    x: 0,
    y: 20,
    toJSON: () => ({}),
  });
}

const renderBar = () => render(<CategoryFilterBar />, { wrapper: createQueryWrapper() });

describe("CategoryFilterBar map obstruction", () => {
  beforeEach(() => {
    stubLayout();
    isMobileRef.current = true;
    // The fuel branch is the one toolbar root that renders from store state
    // alone, with no fetched results behind it.
    useDataSourceStore.setState({ activeSource: "fuel" });
    useCategorySearchStore.setState({ activeCategory: null, mode: "category" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useDataSourceStore.setState({ activeSource: null });
    publishMapObstruction("category-filter-bar", "top", null);
  });

  it("registers the bar's bottom edge on mobile and releases it on unmount", () => {
    const { unmount } = renderBar();
    expect(getMapObstructionInsets().top).toBe(BAR_BOTTOM);
    unmount();
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("registers nothing on desktop, where the bar floats beside the rail", () => {
    isMobileRef.current = false;
    renderBar();
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("registers nothing when no branch renders a toolbar at all", () => {
    useDataSourceStore.setState({ activeSource: null });
    renderBar();
    expect(getMapObstructionInsets().top).toBe(0);
  });
});
