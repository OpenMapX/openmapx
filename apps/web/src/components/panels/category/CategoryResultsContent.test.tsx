import type { CategoryPlace } from "@openmapx/core";
import { useCategorySearchStore, usePlaceStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSheetContext } from "@/components/panels/sheet/sheetState";
import { MapProvider } from "@/integration-api/map/MapContext";
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

describe("category place hours", () => {
  it("keeps uncertain syntax off the result button while allowing selection", () => {
    const place = {
      id: "unknown-hours",
      name: "Café Maybe",
      coordinates: [13.4, 52.5],
      openingHours: "Mo-Fr 09:00-17:00; PH off",
      openingHoursInfo: {
        status: { isOpen: false, isUnknown: true, text: "Mo-Fr 09:00-17:00; PH off" },
      },
    } as CategoryPlace;
    act(() => useCategorySearchStore.setState({ activeCategory: "cafes" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: [place],
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: 1,
      relaxed: [],
      isTransitCategory: false,
    });

    renderPanel(vi.fn());
    const result = screen.getByRole("button", { name: /Café Maybe/ });
    expect(result).toHaveTextContent("openingHours.unconfirmed");
    expect(result).not.toHaveTextContent("Mo-Fr 09:00-17:00; PH off");
    fireEvent.click(result);
    expect(usePlaceStore.getState().selectedPlace?.openingHours).toBe(place.openingHours);
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
