import type { CategoryPlace } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import { cleanup, createQueryWrapper, render, screen, userEvent } from "@/test";

const isMobileRef = { current: true };
const resultsRef = vi.hoisted(() => ({
  current: [] as CategoryPlace[],
  dominantCategory: null as string | null,
}));
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => isMobileRef.current }));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useExploreResults: () => ({
    rawResults: resultsRef.current,
    dominantCategory: resultsRef.dominantCategory,
  }),
}));

import {
  useCategoryFacetStore,
  useCategorySearchStore,
  useDataSourceStore,
  useOpeningHoursStore,
} from "@openmapx/core";
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
    resultsRef.current = [];
    resultsRef.dominantCategory = null;
    // The fuel branch is the one toolbar root that renders from store state
    // alone, with no fetched results behind it.
    useDataSourceStore.setState({ activeSource: "fuel" });
    useCategorySearchStore.setState({ activeCategory: null, mode: "category" });
  });

  afterEach(() => {
    cleanup();
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

function restaurant(id: string, brand: string, qid: string, cuisine = "italian"): CategoryPlace {
  return {
    id,
    name: id,
    coordinates: [0, 0],
    osmTags: { brand, "brand:wikidata": qid, cuisine },
  };
}

describe("CategoryFilterBar facet discovery", () => {
  beforeEach(() => {
    stubLayout();
    isMobileRef.current = true;
    useDataSourceStore.setState({ activeSource: null });
    useCategorySearchStore.setState({ activeCategory: "restaurants", mode: "category" });
    useCategoryFacetStore.getState().reset();
    useOpeningHoursStore.getState().reset();
    resultsRef.current = Array.from({ length: 9 }, (_, i) =>
      restaurant(`place-${i}`, `Brand ${i}`, `Q${i}`, i === 0 ? "italian" : "sushi"),
    );
    resultsRef.dominantCategory = "restaurants";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useCategoryFacetStore.getState().reset();
    useCategorySearchStore.setState({ activeCategory: null });
    publishMapObstruction("category-filter-bar", "top", null);
  });

  it("offers every brand in the selector and keeps a selected brand removable after panning", async () => {
    const user = userEvent.setup();
    const view = renderBar();
    expect(screen.queryByText("Brand 8 · 1")).toBeNull();
    await user.click(screen.getByText("category.filters"));
    await user.click(screen.getByText("Brand 8 · 1"));
    expect(useCategoryFacetStore.getState().selections.brand).toEqual(["Q8"]);
    await user.click(screen.getByText("common.done"));
    resultsRef.current = [];
    view.rerender(<CategoryFilterBar />);
    await user.click(screen.getByText("category.filters"));
    expect(screen.getByText("Q8")).toBeInTheDocument();
    await user.click(screen.getByText("common.done"));
    await user.click(screen.getByRole("button", { name: /category.brand.*Q8/i }));
    expect(useCategoryFacetStore.getState().selections.brand).toBeUndefined();
  });

  it("opens cuisine directly and removes a selected cuisine from the row", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByText("category.cuisine"));
    await user.click(screen.getByText("Italian"));
    expect(useCategoryFacetStore.getState().selections.cuisine).toEqual(["italian"]);
    await user.click(screen.getByText("common.done"));
    await user.click(screen.getByRole("button", { name: /category.cuisine.*Italian/i }));
    expect(useCategoryFacetStore.getState().selections.cuisine).toBeUndefined();
  });

  it("counts active facet groups and leaves opening times as a separate control", async () => {
    const user = userEvent.setup();
    useCategoryFacetStore.getState().setMultiFacet("brand", ["Q0", "Q1"]);
    useCategoryFacetStore.getState().setMultiFacet("cuisine", ["italian"]);
    useCategoryFacetStore.getState().toggleFacet("wheelchairAccessible");
    useOpeningHoursStore.getState().setOpeningHoursFilter("open_now");
    renderBar();
    expect(screen.getByText("3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /category.wheelchairAccessible/i }));
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(useOpeningHoursStore.getState().openingHoursFilter).toBe("open_now");
  });

  it("keeps brand selection available in text results without a dominant category", async () => {
    const user = userEvent.setup();
    useCategorySearchStore.setState({ activeCategory: null, mode: "text" });
    resultsRef.dominantCategory = null;
    useCategoryFacetStore.getState().setMultiFacet("brand", ["Q8"]);
    renderBar();
    expect(screen.getByRole("button", { name: /category.brand.*Brand 8/i })).toBeInTheDocument();
    await user.click(screen.getByText("category.filters"));
    await user.click(screen.getByText("Brand 8 · 1"));
    expect(useCategoryFacetStore.getState().selections.brand).toBeUndefined();
  });
});
