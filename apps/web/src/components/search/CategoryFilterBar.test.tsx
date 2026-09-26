import type { CategoryPlace, OverpassFilter } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import { act, cleanup, createQueryWrapper, render, screen, userEvent } from "@/test";

const isMobileRef = { current: true };
const localeRef = vi.hoisted(() => ({ current: "mock" }));
const resultsRef = vi.hoisted(() => ({
  current: [] as CategoryPlace[],
  dominantCategory: null as string | null,
}));
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => isMobileRef.current }));
vi.mock("next-intl", async () => {
  const [{ default: en }, { default: de }, { mockNextIntl }] = await Promise.all([
    import("../../../../../packages/i18n/locales/en.json"),
    import("../../../../../packages/i18n/locales/de.json"),
    import("@/test/intl"),
  ]);
  return mockNextIntl({
    useTranslations: (namespace: string) => (key: string, values?: Record<string, string>) => {
      if (localeRef.current === "mock") return `${namespace}.${key}`;
      const catalog = localeRef.current === "de" ? de : en;
      const messages = catalog[namespace as keyof typeof catalog] as Record<string, string>;
      return (messages[key] ?? `${namespace}.${key}`).replace(
        /\{(\w+)\}/g,
        (_, name: string) => values?.[name] ?? "",
      );
    },
  });
});
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
  useNlpSearchStore,
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

  it("hides retained facets after closing the category search", () => {
    useCategoryFacetStore.getState().toggleFacet("outdoorSeating");
    renderBar();
    expect(screen.getByText("category.filters")).toBeInTheDocument();

    act(() => useCategorySearchStore.getState().clearCategory());

    expect(useCategoryFacetStore.getState().selections.outdoorSeating).toEqual(["on"]);
    expect(screen.queryByText("category.filters")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /category.outdoorSeating/i })).toBeNull();
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("keeps brand selection available in text results without a dominant category", async () => {
    const user = userEvent.setup();
    useCategorySearchStore.getState().setExploreText("coffee shops");
    resultsRef.dominantCategory = null;
    useCategoryFacetStore.getState().setMultiFacet("brand", ["Q8"]);
    renderBar();
    expect(screen.getByRole("button", { name: /category.brand.*Brand 8/i })).toBeInTheDocument();
    await user.click(screen.getByText("category.filters"));
    await user.click(screen.getByText("Brand 8 · 1"));
    expect(useCategoryFacetStore.getState().selections.brand).toBeUndefined();
  });
});

const baseAdHocFilter: OverpassFilter = {
  selectors: [{ tags: [{ key: "amenity", value: "restaurant" }] }],
};

function showAdHocFilter(filter: OverpassFilter, unmapped: string[] = []) {
  useCategorySearchStore.getState().setAdHocFilter(filter, "Restaurants");
  useNlpSearchStore.setState({
    isNlpActive: true,
    intent: {
      filter,
      spatial_constraint: null,
      time_constraint: null,
      sort_by: "relevance",
      unmapped_attributes: unmapped,
      confidence: 1,
      explanation: "",
    },
  });
}

describe("CategoryFilterBar natural language predicates", () => {
  beforeEach(() => {
    stubLayout();
    localeRef.current = "en";
    useDataSourceStore.setState({ activeSource: null });
    resultsRef.current = [];
    resultsRef.dominantCategory = null;
    useNlpSearchStore.getState().clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localeRef.current = "mock";
    useNlpSearchStore.getState().clear();
    useCategorySearchStore.getState().clearCategory();
    publishMapObstruction("category-filter-bar", "top", null);
  });

  it("names a known positive facet without changing its exact predicate", () => {
    const filter = {
      ...baseAdHocFilter,
      require: [{ key: "outdoor_seating", op: "=" as const, value: "yes" }],
    };
    showAdHocFilter(filter);
    renderBar();
    expect(screen.getByText("Outdoor seating")).toBeInTheDocument();
    expect(useCategorySearchStore.getState().adHocFilter).toEqual(filter);
  });

  it("distinguishes an excluded facet from a positive one", () => {
    const filter = {
      ...baseAdHocFilter,
      exclude: [{ key: "outdoor_seating", op: "=" as const, value: "yes" }],
    };
    showAdHocFilter(filter);
    renderBar();
    expect(screen.getByText("Exclude: Outdoor seating")).toBeInTheDocument();
    expect(useCategorySearchStore.getState().adHocFilter).toEqual(filter);
  });

  it("keeps the exact value when excluding one of several values in a facet", () => {
    const filter = {
      ...baseAdHocFilter,
      exclude: [
        { key: "wheelchair", op: "=" as const, value: "designated" },
        { key: "diet:vegan", op: "=" as const, value: "yes" },
      ],
    };
    showAdHocFilter(filter);
    renderBar();
    expect(
      screen.getByText("Exclude: Wheelchair: designated (wheelchair!=designated)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Exclude: Vegan: yes (diet:vegan!=yes)")).toBeInTheDocument();
    expect(useCategorySearchStore.getState().adHocFilter).toEqual(filter);
  });

  it("states whether an existence predicate requires a present or absent tag", () => {
    const filter = {
      ...baseAdHocFilter,
      require: [{ key: "wheelchair", op: "exists" as const }],
      exclude: [{ key: "internet_access", op: "exists" as const }],
    };
    showAdHocFilter(filter);
    renderBar();
    expect(screen.getByText("Wheelchair tag present")).toBeInTheDocument();
    expect(screen.getByText("Internet access tag absent")).toBeInTheDocument();
    expect(useCategorySearchStore.getState().adHocFilter).toEqual(filter);
  });

  it("shows regex and unsupported exact values with their technical predicates", () => {
    const filter = {
      ...baseAdHocFilter,
      require: [
        { key: "cuisine", op: "~" as const, value: "italian|pizza" },
        { key: "unknown_feature", op: "=" as const, value: "maybe" },
        { key: "wheelchair", op: "=" as const, value: "some_new_value" },
      ],
      exclude: [{ key: "cuisine", op: "~" as const, value: "sushi|thai" }],
    };
    showAdHocFilter(filter);
    renderBar();
    expect(
      screen.getByText("Cuisine matches pattern “italian|pizza” (cuisine~italian|pizza)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Cuisine does not match pattern “sushi|thai” (cuisine!~sushi|thai)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Unknown feature: maybe (unknown_feature=maybe)")).toBeInTheDocument();
    expect(
      screen.getByText("Wheelchair: some_new_value (wheelchair=some_new_value)"),
    ).toBeInTheDocument();
  });

  it("does not call wired internet Wi-Fi or limited access fully accessible", () => {
    const filter = {
      ...baseAdHocFilter,
      require: [
        { key: "internet_access", value: "wired" },
        { key: "wheelchair", value: "limited" },
      ],
    };
    showAdHocFilter(filter);
    renderBar();
    expect(screen.getByText("Internet access: wired (internet_access=wired)")).toBeInTheDocument();
    expect(screen.getByText("Wheelchair: limited (wheelchair=limited)")).toBeInTheDocument();
  });

  it("uses German facet labels and removes the selected duplicate-looking predicate by index", async () => {
    localeRef.current = "de";
    const user = userEvent.setup();
    const filter = {
      ...baseAdHocFilter,
      require: [
        { key: "wheelchair", op: "=" as const, value: "yes" },
        { key: "wheelchair", op: "=" as const, value: "designated" },
      ],
    };
    showAdHocFilter(filter);
    renderBar();
    const chips = screen.getAllByText("Barrierefrei");
    expect(chips).toHaveLength(2);
    await user.click(chips[1].closest(".MuiChip-root")?.querySelector("svg") as SVGElement);
    expect(useCategorySearchStore.getState().adHocFilter?.require).toEqual([filter.require[0]]);
  });

  it("keeps an unmapped notice when no predicate chips remain", async () => {
    const user = userEvent.setup();
    const filter = { ...baseAdHocFilter, require: [{ key: "outdoor_seating", value: "yes" }] };
    showAdHocFilter(filter, ["cozy"]);
    renderBar();
    expect(screen.getByText(/Could not filter by: cozy/)).toBeInTheDocument();
    await user.click(
      screen
        .getByText("Outdoor seating")
        .closest(".MuiChip-root")
        ?.querySelector("svg") as SVGElement,
    );
    expect(useCategorySearchStore.getState().adHocFilter?.require).toBeUndefined();
    expect(screen.getByText(/Could not filter by: cozy/)).toBeInTheDocument();
  });
});
