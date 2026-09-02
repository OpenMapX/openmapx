import { useSidebarStore } from "@openmapx/core";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { DIRECTIONS_DETENTS, LIST_DETENTS } from "./sheet/detents";

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
});
