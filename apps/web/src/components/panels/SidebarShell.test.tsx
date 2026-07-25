import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";

vi.mock("@mui/material/useMediaQuery", () => ({ default: () => true }));

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
