import { useCategorySearchStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSheetContext } from "@/components/panels/sheet/sheetState";
import { MapProvider } from "@/lib/MapContext";
import { act, fireEvent, render, screen } from "@/test";
import { createQueryWrapper } from "@/test/query";
import { CategoryResultsContent } from "./CategoryResultsContent";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

// Real explore results come from live Overpass/NLP hooks; the panel tests only
// need to control the shape CategoryResultsContent renders against, so the
// hook is mocked and given an idle default (matches the "no active
// category" state every real disabled query resolves to).
const mockUseExploreReachResults = vi.fn();
vi.mock("@/lib/useExploreReachResults", () => ({
  useExploreReachResults: () => mockUseExploreReachResults(),
}));

beforeEach(() => {
  act(() => {
    useCategorySearchStore.getState().clearCategory();
  });
  mockUseExploreReachResults.mockReturnValue({
    filtered: undefined,
    isLoading: false,
    isError: false,
    error: null,
    partial: false,
    truncated: false,
    total: undefined,
    relaxed: [],
    isTransitCategory: false,
  });
});

// No active category/text query means every underlying search hook stays
// disabled — the panel mounts idle, which is all the tap-to-expand wiring
// under test needs.
function renderPanel(snapTo: (detent: "peek" | "mid" | "full") => void) {
  const Wrapper = createQueryWrapper();
  return render(
    <Wrapper>
      <MapProvider>
        <MobileSheetContext.Provider
          value={{ detent: "peek", inSheet: true, isExpanded: false, snapTo }}
        >
          <CategoryResultsContent />
        </MobileSheetContext.Provider>
      </MapProvider>
    </Wrapper>,
  );
}

describe("CategoryResultsContent mobile sheet interactions", () => {
  it("tapping the collapsed results list expands the sheet to mid", () => {
    const snapTo = vi.fn();
    const { container } = renderPanel(snapTo);

    fireEvent.click(container.firstElementChild as Element);

    expect(snapTo).toHaveBeenCalledWith("mid");
  });

  it("does nothing once the sheet is past peek", () => {
    const snapTo = vi.fn();
    const Wrapper = createQueryWrapper();
    const { container } = render(
      <Wrapper>
        <MapProvider>
          <MobileSheetContext.Provider
            value={{ detent: "mid", inSheet: true, isExpanded: true, snapTo }}
          >
            <CategoryResultsContent />
          </MobileSheetContext.Provider>
        </MapProvider>
      </Wrapper>,
    );

    fireEvent.click(container.firstElementChild as Element);

    expect(snapTo).not.toHaveBeenCalled();
  });
});

describe("CategoryResultsContent brand empty state", () => {
  it("shows the brand-specific empty message when a brand search has no results in view", () => {
    act(() => {
      useCategorySearchStore
        .getState()
        .setBrandFilter(
          { qid: "Q41171", name: "Aldi", kind: ["brand"], description: "German supermarket chain" },
          { selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }] },
        );
    });
    mockUseExploreReachResults.mockReturnValue({
      filtered: [],
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: false,
    });

    renderPanel(vi.fn());

    expect(screen.getByText("search.noBrandLocationsInView")).toBeInTheDocument();
    expect(screen.queryByText("search.noResultsFound")).not.toBeInTheDocument();
  });
});
