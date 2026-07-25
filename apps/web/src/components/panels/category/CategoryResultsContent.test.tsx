import { useCategorySearchStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSheetContext } from "@/components/panels/sheet/sheetState";
import { MapProvider } from "@/lib/MapContext";
import { act, fireEvent, render } from "@/test";
import { createQueryWrapper } from "@/test/query";
import { CategoryResultsContent } from "./CategoryResultsContent";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

beforeEach(() => {
  act(() => {
    useCategorySearchStore.getState().clearCategory();
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
