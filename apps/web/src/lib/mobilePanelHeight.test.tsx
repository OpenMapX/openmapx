import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobilePanelHeightTracker, useMobilePanelMaxHeight } from "./mobilePanelHeight";

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
    const max = renderHook(() => useMobilePanelMaxHeight());
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
    const max = renderHook(() => useMobilePanelMaxHeight());
    const track = renderHook(() => useMobilePanelHeightTracker("panel", panel.el));
    expect(max.result.current).toBe(0);
    track.unmount();
  });

  it("drops a panel whose element detaches (null element)", () => {
    const panel = makePanel(150);
    const max = renderHook(() => useMobilePanelMaxHeight());
    const track = renderHook(({ el }) => useMobilePanelHeightTracker("panel", el), {
      initialProps: { el: panel.el as HTMLElement | null },
    });
    expect(max.result.current).toBe(150);

    track.rerender({ el: null });
    expect(max.result.current).toBe(0);
    track.unmount();
  });
});
