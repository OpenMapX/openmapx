import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detentIndex } from "@/components/panels/sheet/detents";
import {
  publishMobilePanelHeight,
  useMobilePanelClearance,
  useMobilePanelFollowCap,
  useMobilePanelHeightTracker,
  useWindowHeight,
} from "./mobilePanelHeight";

// The tracker is mobile-only via useMediaQuery; the ref lets tests flip the
// viewport without re-mocking (read lazily so hoisting is safe).
const isMobileRef = { current: true };
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => isMobileRef.current }));

// jsdom has no ResizeObserver; a stub that records instances lets tests fire
// resize callbacks by hand.
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  observed: Element[] = [];
  constructor(readonly callback: (entries: unknown[], observer: unknown) => void) {
    ResizeObserverStub.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve(el: Element) {
    this.observed = this.observed.filter((o) => o !== el);
  }
  disconnect() {
    this.observed = [];
  }
}

function makePanel(height: number) {
  const el = document.createElement("div");
  const state = { height };
  el.getBoundingClientRect = () => ({ height: state.height }) as DOMRect;
  return { el, state };
}

function fireResize(el: HTMLElement) {
  const ro = ResizeObserverStub.instances.find((i) => i.observed.includes(el));
  if (!ro) throw new Error("no ResizeObserver attached to element");
  act(() => ro.callback([], ro));
}

describe("mobilePanelHeight registry", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    isMobileRef.current = true;
  });

  afterEach(() => {
    ResizeObserverStub.instances = [];
    vi.unstubAllGlobals();
  });

  it("reports the max across registered panels and follows resizes and unmounts", () => {
    const sidebar = makePanel(100);
    const navSheet = makePanel(220);
    const max = renderHook(() => useMobilePanelClearance(0));
    expect(max.result.current).toBe(0);

    const trackSidebar = renderHook(() => useMobilePanelHeightTracker("sidebar", sidebar.el));
    expect(max.result.current).toBe(100);

    const trackNav = renderHook(() => useMobilePanelHeightTracker("nav-sheet", navSheet.el));
    expect(max.result.current).toBe(220);

    // The nav sheet collapsing (e.g. drag down) shrinks its tracked height.
    navSheet.state.height = 84;
    fireResize(navSheet.el);
    expect(max.result.current).toBe(100);

    trackSidebar.unmount();
    expect(max.result.current).toBe(84);

    trackNav.unmount();
    expect(max.result.current).toBe(0);
  });

  it("does not register heights on desktop viewports", () => {
    isMobileRef.current = false;
    const panel = makePanel(300);
    const max = renderHook(() => useMobilePanelClearance(0));
    const track = renderHook(() => useMobilePanelHeightTracker("panel", panel.el));
    expect(max.result.current).toBe(0);
    track.unmount();
  });

  it("drops a panel whose element detaches (null element)", () => {
    const panel = makePanel(150);
    const max = renderHook(() => useMobilePanelClearance(0));
    const track = renderHook(({ el }) => useMobilePanelHeightTracker("panel", el), {
      initialProps: { el: panel.el as HTMLElement | null },
    });
    expect(max.result.current).toBe(150);

    track.rerender({ el: null });
    expect(max.result.current).toBe(0);
    track.unmount();
  });
});

describe("mobilePanelHeight direct publication", () => {
  it("publishes a height with no element to measure", () => {
    const max = renderHook(() => useMobilePanelClearance(0));

    act(() => publishMobilePanelHeight("detail", 420));
    expect(max.result.current).toBe(420);

    act(() => publishMobilePanelHeight("detail", 260));
    expect(max.result.current).toBe(260);

    act(() => publishMobilePanelHeight("detail", null));
    expect(max.result.current).toBe(0);
  });
});

describe("mobilePanelHeight clearance", () => {
  it("clamps the tracked height to the registered cap", () => {
    const clearance = renderHook(() => useMobilePanelClearance(1000));
    const cap = renderHook(() => useMobilePanelFollowCap("detail", 400));
    act(() => publishMobilePanelHeight("detail", 700));

    expect(clearance.result.current).toBe(400);

    act(() => publishMobilePanelHeight("detail", null));
    cap.unmount();
  });

  it("falls back to a fraction of the viewport when no cap is registered", () => {
    const clearance = renderHook(() => useMobilePanelClearance(1000));
    act(() => publishMobilePanelHeight("nav-sheet", 900));

    expect(clearance.result.current).toBe(650);

    act(() => publishMobilePanelHeight("nav-sheet", null));
  });

  it("does not raise clearance above the panel's own height", () => {
    const clearance = renderHook(() => useMobilePanelClearance(1000));
    const cap = renderHook(() => useMobilePanelFollowCap("detail", 400));
    act(() => publishMobilePanelHeight("detail", 120));

    expect(clearance.result.current).toBe(120);

    act(() => publishMobilePanelHeight("detail", null));
    cap.unmount();
  });

  // With two surfaces registered at once, the tightest cap has to win — chrome
  // that cleared only the looser one would sit behind the other panel.
  it("applies the tightest cap when several are registered", () => {
    const clearance = renderHook(() => useMobilePanelClearance(1000));
    const loose = renderHook(() => useMobilePanelFollowCap("detail", 600));
    const tight = renderHook(() => useMobilePanelFollowCap("sidebar", 300));
    act(() => publishMobilePanelHeight("detail", 900));

    expect(clearance.result.current).toBe(300);

    tight.unmount();
    expect(clearance.result.current).toBe(600);

    act(() => publishMobilePanelHeight("detail", null));
    loose.unmount();
  });

  it("ignores the viewport fallback before layout reports a height", () => {
    const clearance = renderHook(() => useMobilePanelClearance(0));
    act(() => publishMobilePanelHeight("nav-sheet", 900));

    expect(clearance.result.current).toBe(900);

    act(() => publishMobilePanelHeight("nav-sheet", null));
  });

  // MobileBottomSheet derives its follow cap from `detentIndex(detents).mid` —
  // undefined for a two-snap config (the navigation sheet has no mid, only
  // peek and full) — and only registers a cap when that index resolves to a
  // marker. A two-snap surface must therefore publish no cap at all and let
  // the default viewport-fraction fallback apply, the same as a panel that
  // never calls useMobilePanelFollowCap in the first place.
  it("registers no follow cap for a two-snap config (no mid detent)", () => {
    const twoSnap = { peek: "96px", maxHeight: "480px", initial: "peek" as const };
    expect(detentIndex(twoSnap).mid).toBeUndefined();

    const clearance = renderHook(() => useMobilePanelClearance(1000));
    const cap = renderHook(() =>
      useMobilePanelFollowCap("nav-sheet", detentIndex(twoSnap).mid ?? null),
    );
    act(() => publishMobilePanelHeight("nav-sheet", 900));

    // No cap registered for "nav-sheet" -> falls back to the default fraction,
    // exactly like the "before layout reports a height" case above rather than
    // clamping to a (nonexistent) mid marker.
    expect(clearance.result.current).toBe(650);

    act(() => publishMobilePanelHeight("nav-sheet", null));
    cap.unmount();
  });
});

describe("window height", () => {
  it("tracks layout viewport resizes", () => {
    const height = renderHook(() => useWindowHeight());
    const originalHeight = window.innerHeight;

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(height.result.current).toBe(720);

    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalHeight,
    });
  });
});
