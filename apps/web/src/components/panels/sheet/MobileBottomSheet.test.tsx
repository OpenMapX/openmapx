import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBackNavigationForTests } from "@/lib/backNavigation";
import {
  getMapObstructionInsets,
  publishMapObstruction,
  subscribeMapObstructions,
} from "@/lib/mapObstructions";
import { publishMobilePanelHeight } from "@/lib/mobilePanelHeight";
import { settleHistory } from "@/test/history";
import { detentIndex, PLACE_DETENTS } from "./detents";
import { MobileBottomSheet } from "./MobileBottomSheet";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const TWO_SNAP = { peek: "96px", maxHeight: "480px", initial: "peek" as const };

// jsdom has neither observer, and no `CSS.supports` at all — all three are
// reached for by the bottom-sheet element's constructor and
// `connectedCallback` during its custom-element upgrade. That upgrade
// resolves from an async dynamic import outside any single test's body, so
// these are patched once at module scope (not in a beforeEach/afterEach, which
// would restore them before the upgrade actually runs and leave an unhandled
// exception) rather than restored — each test file runs in its own isolated
// environment.
if (typeof CSS !== "undefined") CSS.supports = () => false;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver;

describe("keyboardDetent", () => {
  it.each([
    { label: "three", config: { ...PLACE_DETENTS, initial: "peek" as const }, upper: 3, middle: 2 },
    { label: "two", config: TWO_SNAP, upper: 2, middle: 2 },
  ])(
    "moves only the focused sheet host through its configured keyboard detents: $label",
    async ({ config, upper, middle }) => {
      vi.stubGlobal("matchMedia", () => ({ matches: false }));
      const view = render(
        <MobileBottomSheet id="keyboard-sheet" zIndex={1} detents={config}>
          <input aria-label="Departure" />
        </MobileBottomSheet>,
      );
      try {
        await act(async () => {
          await customElements.whenDefined("bottom-sheet");
        });
        const host = view.container.querySelector("bottom-sheet") as HTMLElement & {
          snapToPoint: ReturnType<typeof vi.fn>;
        };
        host.snapToPoint = vi.fn();
        const field = screen.getByRole("textbox", { name: "Departure" });
        act(() => field.focus());
        for (const key of ["ArrowUp", "Home", "End"]) {
          expect(fireEvent.keyDown(field, { key })).toBe(true);
          expect(host.snapToPoint).not.toHaveBeenCalled();
        }
        expect(host).toHaveAttribute("tabindex", "0");
        act(() => host.focus());
        expect(document.activeElement).toBe(host);
        const stay = (key: string) => {
          host.snapToPoint.mockClear();
          expect(fireEvent.keyDown(host, { key })).toBe(true);
          expect(host.snapToPoint).not.toHaveBeenCalled();
        };
        const move = (key: string, index: number, detent: "peek" | "mid" | "full") => {
          host.snapToPoint.mockClear();
          expect(fireEvent.keyDown(host, { key })).toBe(false);
          expect(host.snapToPoint).toHaveBeenCalledTimes(1);
          expect(host.snapToPoint).toHaveBeenCalledWith(index, { behavior: "smooth" });
          act(() =>
            host.dispatchEvent(
              new CustomEvent("snap-position-change", {
                detail: {
                  snapIndex: index,
                  sheetState: detent === "full" ? "expanded" : "partially-expanded",
                },
              }),
            ),
          );
        };
        stay("ArrowDown");
        stay("Enter");
        if (upper === 3) {
          move("ArrowUp", middle, "mid");
          move("ArrowUp", upper, "full");
        } else move("ArrowUp", upper, "full");
        stay("ArrowUp");
        stay("End");
        if (upper === 3) {
          move("ArrowDown", middle, "mid");
          move("ArrowDown", 1, "peek");
        } else move("ArrowDown", 1, "peek");
        stay("Home");
        move("End", upper, "full");
        move("Home", 1, "peek");
      } finally {
        view.unmount();
        vi.unstubAllGlobals();
      }
    },
  );
});

describe("snap marker keying", () => {
  // The snap-marker `<div>`s are keyed by position, not by their `--snap`
  // value: for the navigation sheet that value is the measured header height,
  // which changes whenever the maneuver banner rewraps mid-drive. Keying by
  // value would unmount and remount the very marker the browser is snapped
  // to. jsdom has no layout engine, so offsetTop-based geometry can't be
  // exercised here — this instead pins the thing a value-based key would get
  // wrong: DOM node identity across a snap value change while the sheet stays
  // mounted and open.
  it("keeps the same marker DOM nodes when a detent length changes", () => {
    const before = { peek: "96px", maxHeight: "480px", initial: "peek" as const };
    const after = { peek: "140px", maxHeight: "480px", initial: "peek" as const };
    const { container, rerender } = render(
      <MobileBottomSheet id="test-sheet" zIndex={1} detents={before}>
        <div>content</div>
      </MobileBottomSheet>,
    );
    const beforeMarkers = Array.from(container.querySelectorAll('[slot="snap"]'));
    expect(beforeMarkers).toHaveLength(2);
    // Snapshot the peek marker's rendered length before it's overwritten in
    // place — its DOM node is reused (see the identity assertions below), so
    // reading the attribute off that same reference after the rerender would
    // just show the new value twice.
    const beforePeekStyle = beforeMarkers[1].getAttribute("style");

    rerender(
      <MobileBottomSheet id="test-sheet" zIndex={1} detents={after}>
        <div>content</div>
      </MobileBottomSheet>,
    );
    const afterMarkers = Array.from(container.querySelectorAll('[slot="snap"]'));
    expect(afterMarkers).toHaveLength(2);

    // Same node at each position, even though the peek marker's `--snap`
    // value has changed.
    expect(afterMarkers[0]).toBe(beforeMarkers[0]);
    expect(afterMarkers[1]).toBe(beforeMarkers[1]);
    expect(afterMarkers[1].getAttribute("style")).not.toBe(beforePeekStyle);
  });
});

describe("bottom obstruction publishing", () => {
  const SHEET_ID = "obstruction-sheet";
  // TWO_SNAP declares no mid detent, so the cap the sheet publishes against is
  // the viewport fraction rather than a snap marker's offsetTop — which jsdom,
  // having no layout, would report as 0 and turn into a 1px cap.
  const sheet = (obscured?: boolean) => (
    <MobileBottomSheet id={SHEET_ID} zIndex={1} detents={TWO_SNAP} obscured={obscured}>
      <div>content</div>
    </MobileBottomSheet>
  );

  // PLACE_DETENTS does declare a mid detent, so this one resolves a real cap
  // off its snap markers — which is what makes a cap change reachable below.
  const midDetentSheet = () => (
    <MobileBottomSheet id={SHEET_ID} zIndex={1} detents={PLACE_DETENTS}>
      <div>content</div>
    </MobileBottomSheet>
  );

  const hostOf = (container: HTMLElement) => container.querySelector("bottom-sheet") as HTMLElement;

  /**
   * Moves the mid detent. The sheet reads the cap as the mid marker's
   * `offsetTop + 1`, which jsdom always reports as 0, and re-reads it on a
   * window resize — the on-screen keyboard, a rotation, the URL bar collapsing.
   * Every marker is given the same offset so the test does not have to restate
   * the component's own index arithmetic.
   */
  function resizeMidDetentTo(host: HTMLElement, midPx: number) {
    for (const marker of host.querySelectorAll<HTMLElement>('[slot="snap"]')) {
      Object.defineProperty(marker, "offsetTop", { value: midPx - 1, configurable: true });
    }
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  // The host is a fixed-height scroll container, so how much of the sheet shows
  // is how far the host has been scrolled. jsdom neither lays the host out nor
  // honours a `scrollTop` write, so the geometry is pinned by hand.
  function scrollHostTo(host: HTMLElement, visiblePx: number) {
    for (const [property, value] of [
      ["clientHeight", 800],
      ["scrollHeight", 1600],
      ["scrollTop", visiblePx],
    ] as const) {
      Object.defineProperty(host, property, { value, configurable: true });
    }
  }

  // Vitest's fake timers drive `requestAnimationFrame` too, so a scroll reaches
  // the publish one frame later and the settle delay runs from there.
  const FRAME_MS = 20;
  const SETTLE_MS = 120;

  /** Moves the sheet and lets it come to rest, as a finger lifting would. */
  function settleSheetAt(host: HTMLElement, visiblePx: number) {
    scrollHostTo(host, visiblePx);
    host.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(FRAME_MS + SETTLE_MS);
  }

  // Both singletons the publishing effect writes, so nothing an earlier test
  // left behind can seed a later one.
  afterEach(() => {
    vi.useRealTimers();
    publishMapObstruction(SHEET_ID, "bottom", null);
    publishMobilePanelHeight(SHEET_ID, null);
  });

  it("publishes the sheet's extent only once it has stopped moving", () => {
    vi.useFakeTimers();
    const { container } = render(sheet());
    const host = hostOf(container);
    scrollHostTo(host, 240);

    host.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(FRAME_MS);
    // The height is known by now, but a sheet still under the finger has no
    // settled height worth re-framing the camera against.
    expect(getMapObstructionInsets().bottom).toBe(0);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(getMapObstructionInsets().bottom).toBe(240);
  });

  it("re-frames as soon as a covered sheet is uncovered", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(sheet(true));
    scrollHostTo(hostOf(container), 240);

    rerender(sheet());

    // Uncovering is not a drag: the sheet is already at rest, so the framing
    // has to be right on the commit that reveals it, not a settle delay later.
    expect(getMapObstructionInsets().bottom).toBe(240);
  });

  it("takes a covered sheet straight back out of the framing", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(sheet());
    settleSheetAt(hostOf(container), 240);
    expect(getMapObstructionInsets().bottom).toBe(240);

    rerender(sheet(true));
    expect(getMapObstructionInsets().bottom).toBe(0);
  });

  it("applies a new cap without ever letting the framing lapse", async () => {
    vi.useFakeTimers();
    const { container } = render(midDetentSheet());
    const host = hostOf(container);
    // Until the element upgrades, every marker sits at the same flow position
    // and the sheet deliberately refuses to read a mid detent off them.
    await act(async () => {
      await customElements.whenDefined("bottom-sheet");
    });

    resizeMidDetentTo(host, 400);
    settleSheetAt(host, 240);
    expect(getMapObstructionInsets().bottom).toBe(240);

    // Every value the camera would be given, in order. The resize below moves
    // the mid detent under the sheet's current height, so the new cap binds —
    // and it has to bind on that same commit, with no timers advanced and
    // without the entry passing through zero on the way. A zero in here is the
    // camera framing for an absent sheet and then framing straight back.
    const published: number[] = [];
    const unsubscribe = subscribeMapObstructions(() =>
      published.push(getMapObstructionInsets().bottom),
    );
    resizeMidDetentTo(host, 200);
    unsubscribe();

    expect(published).toEqual([200]);
  });

  it("releases the obstruction when the sheet unmounts", () => {
    vi.useFakeTimers();
    const { container, unmount } = render(sheet());
    settleSheetAt(hostOf(container), 240);
    expect(getMapObstructionInsets().bottom).toBe(240);

    unmount();
    expect(getMapObstructionInsets().bottom).toBe(0);
  });
});

describe("controlled transition interruption", () => {
  it.each(["scrollend", "settle"])(
    "reports a user-interrupted transition on %s without another snap event",
    (completion) => {
      vi.useFakeTimers();
      vi.stubGlobal("matchMedia", () => ({ matches: false }));
      const onChange = vi.fn();
      const view = (detent: "peek" | "full") => (
        <MobileBottomSheet
          id="interrupted"
          zIndex={1}
          detents={TWO_SNAP}
          detent={detent}
          onDetentChange={onChange}
        >
          <div>content</div>
        </MobileBottomSheet>
      );
      const { container, rerender } = render(view("peek"));
      const host = container.querySelector("bottom-sheet") as HTMLElement;
      Object.defineProperty(host, "snapToPoint", { value: vi.fn(), configurable: true });
      rerender(view("full"));
      act(() =>
        host.dispatchEvent(
          new CustomEvent("snap-position-change", {
            detail: { snapIndex: 1, sheetState: "partially-expanded" },
          }),
        ),
      );
      expect(onChange).not.toHaveBeenCalled();
      act(() => {
        if (completion === "scrollend") host.dispatchEvent(new Event("scrollend"));
        else {
          host.dispatchEvent(new Event("scroll"));
          vi.advanceTimersByTime(150);
        }
      });
      expect(onChange).toHaveBeenCalledWith("peek");
      vi.useRealTimers();
    },
  );

  it("reverses an opening transition before its first snap notification", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const onChange = vi.fn();
    const view = (detent: "peek" | "full") => (
      <MobileBottomSheet
        id="controlled"
        zIndex={1}
        detents={TWO_SNAP}
        detent={detent}
        onDetentChange={onChange}
      >
        <div>content</div>
      </MobileBottomSheet>
    );
    const { container, rerender } = render(view("peek"));
    const host = container.querySelector("bottom-sheet") as HTMLElement & {
      snapToPoint: ReturnType<typeof vi.fn>;
    };
    host.snapToPoint = vi.fn();
    rerender(view("full"));
    expect(host.snapToPoint).toHaveBeenLastCalledWith(2, { behavior: "smooth" });
    rerender(view("peek"));
    expect(host.snapToPoint).toHaveBeenLastCalledWith(1, { behavior: "smooth" });
    act(() =>
      host.dispatchEvent(
        new CustomEvent("snap-position-change", {
          detail: { snapIndex: 2, sheetState: "expanded" },
        }),
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
    act(() => host.dispatchEvent(new Event("scrollend")));
    act(() =>
      host.dispatchEvent(
        new CustomEvent("snap-position-change", {
          detail: { snapIndex: 2, sheetState: "expanded" },
        }),
      ),
    );
    expect(onChange).toHaveBeenCalledWith("full");
  });
});

describe("MobileBottomSheet and Back", () => {
  function expand(host: HTMLElement) {
    act(() =>
      host.dispatchEvent(
        new CustomEvent("snap-position-change", {
          detail: { snapIndex: detentIndex(PLACE_DETENTS).full, sheetState: "expanded" },
        }),
      ),
    );
  }

  it("lowers a fully expanded sheet to its middle detent", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    window.history.replaceState(null, "", "/");
    resetBackNavigationForTests();
    const { container } = render(
      <MobileBottomSheet id="back" zIndex={1} detents={PLACE_DETENTS}>
        <div>content</div>
      </MobileBottomSheet>,
    );
    const host = container.querySelector("bottom-sheet") as HTMLElement & {
      snapToPoint: ReturnType<typeof vi.fn>;
    };
    host.snapToPoint = vi.fn();
    expand(host);
    expect(window.history.state?.omx?.depth).toBe(1);

    window.history.back();
    await act(settleHistory);

    expect(host.snapToPoint).toHaveBeenLastCalledWith(detentIndex(PLACE_DETENTS).mid, {
      behavior: "smooth",
    });
  });

  it("adds no entry while another sheet covers it", () => {
    window.history.replaceState(null, "", "/");
    resetBackNavigationForTests();
    const { container } = render(
      <MobileBottomSheet id="covered" zIndex={1} detents={PLACE_DETENTS} obscured>
        <div>content</div>
      </MobileBottomSheet>,
    );
    expand(container.querySelector("bottom-sheet") as HTMLElement);
    expect(window.history.state?.omx?.depth ?? 0).toBe(0);
  });
});

describe("MobileBottomSheet swipe-down to close", () => {
  function snap(host: HTMLElement, snapIndex: number, sheetState: string) {
    act(() =>
      host.dispatchEvent(
        new CustomEvent("snap-position-change", { detail: { snapIndex, sheetState } }),
      ),
    );
  }

  /** Lets the sheet come to rest at `snapIndex`: the snap, then a quiet spell after scrolling. */
  function restAt(host: HTMLElement, snapIndex: number) {
    snap(host, snapIndex, "partially-expanded");
    act(() => {
      host.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(200);
    });
  }

  function renderSheet(props: { onDismiss?: () => void; obscured?: boolean }) {
    const { container } = render(
      <MobileBottomSheet id="dismiss" zIndex={1} detents={PLACE_DETENTS} {...props}>
        <div>content</div>
      </MobileBottomSheet>,
    );
    return container.querySelector("bottom-sheet") as HTMLElement;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes once swiped down from its lowest detent", () => {
    const onDismiss = vi.fn();
    const host = renderSheet({ onDismiss });
    restAt(host, detentIndex(PLACE_DETENTS).peek);
    expect(host.hasAttribute("swipe-to-dismiss")).toBe(true);
    snap(host, 0, "collapsed");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("offers no closing position while resting higher, so a flick only lowers it", () => {
    const host = renderSheet({ onDismiss: vi.fn() });
    expect(host.hasAttribute("swipe-to-dismiss")).toBe(false);
    restAt(host, detentIndex(PLACE_DETENTS).mid ?? 2);
    expect(host.hasAttribute("swipe-to-dismiss")).toBe(false);
  });

  it("ignores the collapsed position reported before the sheet first comes to rest", () => {
    const onDismiss = vi.fn();
    const host = renderSheet({ onDismiss });
    snap(host, 0, "collapsed");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not close while another sheet covers it", () => {
    const onDismiss = vi.fn();
    const host = renderSheet({ onDismiss, obscured: true });
    restAt(host, detentIndex(PLACE_DETENTS).peek);
    snap(host, 0, "collapsed");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps its lowest detent as the floor without a dismiss handler", () => {
    const host = renderSheet({});
    restAt(host, detentIndex(PLACE_DETENTS).peek);
    expect(host.hasAttribute("swipe-to-dismiss")).toBe(false);
  });
});
