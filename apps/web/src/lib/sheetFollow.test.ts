// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishMobileFooterSurface } from "@/lib/mobileFooterSurface";
import {
  onSheetFooter,
  planAboveFooter,
  planSheetFollow,
  resetSheetFollowSupport,
  SHEET_FOLLOW_TIMELINE,
  type SheetFollowTrack,
  sheetFollowSx,
  useSheetFollowTrack,
} from "./sheetFollow";

const TRACK: SheetFollowTrack = { scrollStart: 4, cap: 440, lift: 0, floor: 0 };

describe("planSheetFollow", () => {
  it("rises one pixel per visible sheet pixel up to the cap", () => {
    expect(planSheetFollow(TRACK, { offset: 12 })).toEqual({
      base: 12,
      start: 4,
      end: 444,
      travel: 440,
    });
  });

  it("holds a floor until the sheet edge passes it", () => {
    // clamp(102, 46 + f, ∞): flat until f = 56.
    expect(planSheetFollow(TRACK, { offset: 46, min: 102 })).toEqual({
      base: 102,
      start: 60,
      end: 444,
      travel: 384,
    });
  });

  it("stops at a ceiling below the cap", () => {
    expect(planSheetFollow(TRACK, { offset: 12, max: 212 })).toEqual({
      base: 12,
      start: 4,
      end: 204,
      travel: 200,
    });
  });

  it("does not move when the floor is never reached under the cap", () => {
    const plan = planSheetFollow(TRACK, { offset: 0, min: 600 });
    expect(plan.base).toBe(600);
    expect(plan.travel).toBe(0);
    expect(sheetFollowSx(plan)).toEqual({});
  });

  it("stands on the undocked footer, and on the sheet edge once it docks", () => {
    const track = { ...TRACK, lift: 20, floor: 30 };
    expect(onSheetFooter(track, { docked: false, height: 34 }, 12)).toEqual({
      offset: 66,
      min: 76,
    });
    expect(onSheetFooter(track, { docked: true, height: 34 }, 12)).toBeNull();
  });
});

describe("planAboveFooter", () => {
  it("clears the footer riding the sheet, then the sheet edge once it docks, above a floor", () => {
    expect(planAboveFooter(TRACK, { docked: false, height: 34 }, 12, 102)).toEqual({
      base: 102,
      start: 60,
      end: 444,
      travel: 384,
    });
    expect(planAboveFooter(TRACK, { docked: true, height: 34 }, 12, 102)).toEqual({
      base: 102,
      start: 94,
      end: 444,
      travel: 350,
    });
  });
});

describe("sheetFollowSx", () => {
  it("drives the shared keyframes from the sheet timeline over the planned range", () => {
    expect(sheetFollowSx({ base: 12, start: 4, end: 444, travel: 440 })).toEqual({
      animationName: "omx-sheet-follow",
      animationDuration: "auto",
      animationTimingFunction: "linear",
      animationFillMode: "both",
      animationTimeline: SHEET_FOLLOW_TIMELINE,
      animationRange: "4px 444px",
      "--omx-sheet-follow-travel": "440px",
    });
    expect(sheetFollowSx(null)).toEqual({});
  });
});

describe("useSheetFollowTrack", () => {
  const mobile = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const published: string[] = [];

  function sheet(id: string, stackLevel: number) {
    const host = document.createElement("div");
    const outlet = document.createElement("div");
    host.append(outlet);
    document.body.append(host);
    Object.defineProperties(host, {
      scrollHeight: { value: 1590, configurable: true },
      clientHeight: { value: 793, configurable: true },
    });
    published.push(id);
    act(() =>
      publishMobileFooterSurface(id, {
        host,
        outlet,
        stackLevel,
        visibleHeight: 180,
        bottom: 824,
        followCap: 440,
      }),
    );
    return host;
  }

  beforeEach(() => {
    resetSheetFollowSupport();
    vi.stubGlobal("CSS", { supports: () => true });
    vi.stubGlobal("matchMedia", () => mobile);
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  });
  afterEach(() => {
    for (const id of published.splice(0)) act(() => publishMobileFooterSurface(id, null));
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    resetSheetFollowSupport();
  });

  it("names the top sheet's scroll timeline and reports its geometry", () => {
    const { result, unmount } = renderHook(() => useSheetFollowTrack());
    const detail = sheet("detail", 11);

    expect(detail.style.getPropertyValue("scroll-timeline")).toBe(`${SHEET_FOLLOW_TIMELINE} y`);
    expect(result.current).toEqual({ scrollStart: 4, cap: 440, lift: 20, floor: 0 });

    // A sheet stacked above takes the timeline over; only one host may carry the name.
    const navigation = sheet("navigation", 1300);
    expect(navigation.style.getPropertyValue("scroll-timeline")).toBe(`${SHEET_FOLLOW_TIMELINE} y`);
    expect(detail.style.getPropertyValue("scroll-timeline")).toBe("");

    unmount();
    expect(navigation.style.getPropertyValue("scroll-timeline")).toBe("");
  });

  it("leaves followers on the published heights where the browser cannot run the follow", () => {
    vi.stubGlobal("CSS", { supports: (rule: string) => !rule.includes("timeline") });
    const { result } = renderHook(() => useSheetFollowTrack());
    const detail = sheet("detail", 11);

    expect(result.current).toBeNull();
    expect(detail.style.getPropertyValue("scroll-timeline")).toBe("");
  });

  it("drops the track on wider screens, where sheets give way to side panels", () => {
    mobile.matches = false;
    try {
      const { result } = renderHook(() => useSheetFollowTrack());
      sheet("detail", 11);
      expect(result.current).toBeNull();
    } finally {
      mobile.matches = true;
    }
  });
});
