import { useSidebarStore } from "@openmapx/core";
import { act, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEARCH_BAR_CLEARANCE } from "@/lib/layout";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import { render, screen } from "@/test";

const isMobileRef = { current: true };
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => isMobileRef.current }));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

vi.mock("./sheet/MobileBottomSheet", () => ({
  MobileBottomSheet: ({
    detents,
    children,
  }: {
    detents: { mid: string };
    children: React.ReactNode;
  }) => (
    <div data-testid="sheet" data-mid={detents.mid}>
      {children}
    </div>
  ),
}));

import { SidebarShell } from "./SidebarShell";
import { useSearchBarClearance } from "./searchBarClearance";
import { DIRECTIONS_DETENTS, LIST_DETENTS } from "./sheet/detents";

function ClearanceProbe() {
  return <span data-testid="probe">{useSearchBarClearance() ?? "none"}</span>;
}

describe("SidebarShell on mobile", () => {
  it("defaults to LIST_DETENTS when no detents prop is passed", async () => {
    render(<SidebarShell>content</SidebarShell>);
    const sheet = await screen.findByTestId("sheet");
    expect(sheet.dataset.mid).toBe(LIST_DETENTS.mid);
  });

  it("forwards a surface-specific detents prop through to the sheet", async () => {
    render(<SidebarShell detents={DIRECTIONS_DETENTS}>content</SidebarShell>);
    const sheet = await screen.findByTestId("sheet");
    expect(sheet.dataset.mid).toBe(DIRECTIONS_DETENTS.mid);
  });

  it("gives content no search-bar clearance, since the sheet sits below the bar", async () => {
    render(
      <SidebarShell searchBarClearance="content">
        <ClearanceProbe />
      </SidebarShell>,
    );
    expect((await screen.findByTestId("probe")).textContent).toBe("none");
  });
});

// The obstruction registry is a module singleton, so a test that leaves an
// entry behind would silently seed the next one.
afterEach(() => publishMapObstruction("sidebar", "left", null));

describe("SidebarShell on desktop", () => {
  afterEach(() => {
    isMobileRef.current = true;
    useSidebarStore.setState({ collapsed: false });
  });

  it("registers the rail as a left obstruction and releases it when collapsed or unmounted", () => {
    isMobileRef.current = false;
    const { unmount } = render(<SidebarShell>content</SidebarShell>);
    expect(getMapObstructionInsets().left).toBe(400);
    act(() => useSidebarStore.setState({ collapsed: true }));
    expect(getMapObstructionInsets().left).toBe(0);
    act(() => useSidebarStore.setState({ collapsed: false }));
    expect(getMapObstructionInsets().left).toBe(400);
    unmount();
    expect(getMapObstructionInsets().left).toBe(0);
  });

  describe("search-bar clearance", () => {
    it("reserves the strip with an opaque band by default, leaving content nothing to offset", () => {
      isMobileRef.current = false;
      render(
        <SidebarShell>
          <ClearanceProbe />
        </SidebarShell>,
      );
      expect(screen.getByTestId("probe").textContent).toBe("none");
      const band = screen.getByTestId("search-bar-band");
      expect(band).toHaveStyle({ position: "sticky", height: SEARCH_BAR_CLEARANCE });
      expect(band).not.toHaveStyle({ opacity: "0" });
    });

    it("hands the inset to content under the bar and fills the band in once the rail scrolls", () => {
      isMobileRef.current = false;
      render(
        <SidebarShell searchBarClearance="content">
          <ClearanceProbe />
        </SidebarShell>,
      );
      expect(screen.getByTestId("probe").textContent).toBe(SEARCH_BAR_CLEARANCE);
      const band = screen.getByTestId("search-bar-band");
      expect(band).toHaveStyle({ opacity: "0", pointerEvents: "none" });

      const rail = band.parentElement as HTMLElement;
      rail.scrollTop = 120;
      fireEvent.scroll(rail);
      expect(band).toHaveStyle({ opacity: "1" });

      rail.scrollTop = 0;
      fireEvent.scroll(rail);
      expect(band).toHaveStyle({ opacity: "0" });
    });

    it("reserves nothing for a panel that hides the bar", () => {
      isMobileRef.current = false;
      render(
        <SidebarShell searchBarClearance="none">
          <ClearanceProbe />
        </SidebarShell>,
      );
      expect(screen.getByTestId("probe").textContent).toBe("none");
      expect(screen.queryByTestId("search-bar-band")).toBeNull();
    });
  });
});
