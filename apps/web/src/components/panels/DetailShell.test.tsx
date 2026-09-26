import { useSidebarStore } from "@openmapx/core";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import { render } from "@/test";

const isMobileRef = { current: false };
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => isMobileRef.current }));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("./sheet/MobileBottomSheet", () => ({
  MobileBottomSheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { DetailShell } from "./DetailShell";

describe("DetailShell on desktop", () => {
  // The obstruction registry is a module singleton, so a test that leaves an
  // entry behind would silently seed the next one.
  afterEach(() => {
    publishMapObstruction("detail", "left", null);
    useSidebarStore.setState({ activeSidebarId: null, collapsed: false });
  });

  it("never renders an orphan or a duplicate desktop place card", () => {
    for (const activeSidebarId of [null, "place"]) {
      useSidebarStore.setState({ activeSidebarId, collapsed: false });
      const { container, unmount } = render(<DetailShell>card</DetailShell>);
      expect(container.querySelector(".MuiPaper-root")).toBeNull();
      expect(getMapObstructionInsets().left).toBe(0);
      unmount();
    }
  });

  it("shows the card and its obstruction only while the other rail is visible", () => {
    useSidebarStore.setState({ activeSidebarId: "category", collapsed: false });
    const { container, unmount } = render(<DetailShell>card</DetailShell>);
    expect(container.querySelector(".MuiPaper-root")).not.toBeNull();
    expect(getMapObstructionInsets().left).toBe(400 + 24 + 376);
    act(() => useSidebarStore.setState({ collapsed: true }));
    expect(container.querySelector(".MuiPaper-root")).toBeNull();
    expect(getMapObstructionInsets().left).toBe(0);
    act(() => useSidebarStore.setState({ collapsed: false }));
    expect(container.querySelector(".MuiPaper-root")).not.toBeNull();
    expect(getMapObstructionInsets().left).toBe(400 + 24 + 376);
    unmount();
    expect(getMapObstructionInsets().left).toBe(0);
  });
});
