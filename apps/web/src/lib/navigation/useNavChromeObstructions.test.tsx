import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NAV_LANDSCAPE_PANEL_WIDTH } from "@/lib/layout";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import { useNavChromeObstructions } from "./useNavChromeObstructions";

describe("useNavChromeObstructions", () => {
  afterEach(() => {
    publishMapObstruction("ground-nav-column", "left", null);
    publishMapObstruction("ground-nav-banner", "top", null);
    publishMapObstruction("transit-nav-column", "left", null);
    publishMapObstruction("transit-nav-banner", "top", null);
  });

  it("registers the wide-screen column while navigating and releases it on arrival", () => {
    const { rerender, unmount } = renderHook(
      (props: { isMobile: boolean; arrived: boolean; bannerEl: HTMLElement | null }) =>
        useNavChromeObstructions("ground", props),
      { initialProps: { isMobile: false, arrived: false, bannerEl: null } },
    );
    expect(getMapObstructionInsets().left).toBe(NAV_LANDSCAPE_PANEL_WIDTH + 32);
    rerender({ isMobile: false, arrived: true, bannerEl: null });
    expect(getMapObstructionInsets().left).toBe(0);
    unmount();
  });

  it("measures the banner on phones instead of reserving a column", () => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ top: 0, bottom: 96, left: 0, right: 390 }) as DOMRect;
    const { unmount } = renderHook(() =>
      useNavChromeObstructions("ground", { isMobile: true, arrived: false, bannerEl: el }),
    );
    expect(getMapObstructionInsets()).toMatchObject({ left: 0, top: 96 });
    unmount();
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("keeps each view's registration under its own id", () => {
    const { unmount } = renderHook(() =>
      useNavChromeObstructions("transit", { isMobile: false, arrived: false, bannerEl: null }),
    );
    // Releasing the driving view's column must not release the transit one:
    // both views can be mounted at once, and only one of them covers the map.
    publishMapObstruction("ground-nav-column", "left", null);
    expect(getMapObstructionInsets().left).toBe(NAV_LANDSCAPE_PANEL_WIDTH + 32);
    unmount();
    expect(getMapObstructionInsets().left).toBe(0);
  });
});
