import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import { fireEvent, render, screen } from "@/test";

const isMobileRef = { current: true };
const sourcesRef: { current: Array<{ id: string; categoryChipLabel: string }> } = { current: [] };
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => isMobileRef.current }));
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return { ...actual, useDataSources: () => ({ data: { sources: sourcesRef.current } }) };
});

import {
  useCategorySearchStore,
  useDataSourceStore,
  useDirectionsStore,
  useMapStore,
} from "@openmapx/core";
import { CategoryChips } from "./CategoryChips";

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
 * screen". Every assertion here would then pass for the wrong reason, so the
 * chip row is given the box it occupies on a phone.
 */
const CHIP_ROW_BOTTOM = 56;

function stubLayout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    top: 20,
    bottom: CHIP_ROW_BOTTOM,
    left: 0,
    right: 320,
    width: 320,
    height: 36,
    x: 0,
    y: 20,
    toJSON: () => ({}),
  });
}

describe("CategoryChips map obstruction", () => {
  beforeEach(() => {
    stubLayout();
    isMobileRef.current = true;
    sourcesRef.current = [];
    // The store's default zoom is 2, which is below the chip row's own
    // visibility threshold.
    useMapStore.setState({ zoom: 12 });
    useDirectionsStore.setState({ isOpen: false });
    useCategorySearchStore.setState({ activeCategory: null, mode: "category" });
    useDataSourceStore.setState({ activeSource: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    publishMapObstruction("category-chips", "top", null);
  });

  it("registers the row's bottom edge on mobile and releases it on unmount", () => {
    const { unmount } = render(<CategoryChips />);
    expect(getMapObstructionInsets().top).toBe(CHIP_ROW_BOTTOM);
    unmount();
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("registers nothing on desktop, where the row floats beside the rail", () => {
    isMobileRef.current = false;
    render(<CategoryChips />);
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("registers nothing while the row is faded out at low zoom", () => {
    useMapStore.setState({ zoom: 4 });
    render(<CategoryChips />);
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("registers nothing while the row is hidden behind another surface", () => {
    useDirectionsStore.setState({ isOpen: true });
    render(<CategoryChips />);
    expect(getMapObstructionInsets().top).toBe(0);
  });
});

describe("CategoryChips discovery order", () => {
  beforeEach(() => {
    isMobileRef.current = true;
    useMapStore.setState({ zoom: 12 });
    useDirectionsStore.setState({ isOpen: false });
    useCategorySearchStore.setState({ activeCategory: null, mode: "category" });
    useDataSourceStore.setState({ activeSource: null });
  });

  it("puts everyday places before transport sources regardless of source registration order", () => {
    sourcesRef.current = [
      { id: "webcam", categoryChipLabel: "Webcams" },
      { id: "scooter-sharing", categoryChipLabel: "E-Scooters" },
      { id: "parking", categoryChipLabel: "Parking" },
      { id: "bike-sharing", categoryChipLabel: "Bike Sharing" },
      { id: "car-sharing", categoryChipLabel: "Car Sharing" },
      { id: "ev-charging", categoryChipLabel: "EV Charging" },
      { id: "fuel", categoryChipLabel: "Gas Stations" },
    ];

    render(<CategoryChips />);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Restaurants",
      "Hotels",
      "Transit",
      "Activities",
      "Bike Sharing",
      "E-Scooters",
      "Car Sharing",
      "Parking",
      "EV Charging",
      "Gas Stations",
      "Museums",
      "Pharmacies",
      "ATMs",
      "Webcams",
    ]);
  });

  it("skips unavailable sources and retains separate actions when a source shares a category id", () => {
    sourcesRef.current = [
      { id: "transit", categoryChipLabel: "Transit source" },
      { id: "transit", categoryChipLabel: "Transit source" },
    ];

    const { unmount } = render(<CategoryChips />);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Restaurants",
      "Hotels",
      "Transit",
      "Activities",
      "Museums",
      "Pharmacies",
      "ATMs",
      "Transit source",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Transit source" }));
    expect(useDataSourceStore.getState().activeSource).toBe("transit");

    unmount();
    useDataSourceStore.setState({ activeSource: null });
    render(<CategoryChips />);
    fireEvent.click(screen.getByRole("button", { name: "Transit" }));
    expect(useCategorySearchStore.getState().activeCategory).toBe("transit");
  });
});
