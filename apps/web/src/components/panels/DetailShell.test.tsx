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
    useSidebarStore.setState({ collapsed: false });
  });

  it("registers the card's right edge beside the rail, and beside the collapse gap when collapsed", () => {
    const { unmount } = render(<DetailShell>card</DetailShell>);
    expect(getMapObstructionInsets().left).toBe(400 + 24 + 376);
    act(() => useSidebarStore.setState({ collapsed: true }));
    expect(getMapObstructionInsets().left).toBe(24 + 376);
    unmount();
    expect(getMapObstructionInsets().left).toBe(0);
  });
});
