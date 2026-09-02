import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMapObstructionInsets,
  publishMapObstruction,
  subscribeMapObstructions,
} from "@/lib/mapObstructions";
import { publishMobilePanelHeight } from "@/lib/mobilePanelHeight";
import { PLACE_DETENTS } from "./detents";
import { isHostKeyDown, keyboardDetent, MobileBottomSheet } from "./MobileBottomSheet";

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
  it("steps up and down between detents", () => {
    expect(keyboardDetent("ArrowUp", "peek", PLACE_DETENTS)).toBe("mid");
    expect(keyboardDetent("ArrowUp", "mid", PLACE_DETENTS)).toBe("full");
    expect(keyboardDetent("ArrowDown", "full", PLACE_DETENTS)).toBe("mid");
  });

  it("stops at the ends instead of wrapping", () => {
    expect(keyboardDetent("ArrowUp", "full", PLACE_DETENTS)).toBeNull();
    expect(keyboardDetent("ArrowDown", "peek", PLACE_DETENTS)).toBeNull();
  });

  it("jumps with Home and End", () => {
    expect(keyboardDetent("Home", "full", PLACE_DETENTS)).toBe("peek");
    expect(keyboardDetent("End", "peek", PLACE_DETENTS)).toBe("full");
  });

  it("ignores unrelated keys", () => {
    expect(keyboardDetent("Enter", "mid", PLACE_DETENTS)).toBeNull();
  });

  it("steps straight from peek to full without a mid detent", () => {
    expect(keyboardDetent("ArrowUp", "peek", TWO_SNAP)).toBe("full");
    expect(keyboardDetent("ArrowDown", "full", TWO_SNAP)).toBe("peek");
  });

  it("still jumps with Home and End without a mid detent", () => {
    expect(keyboardDetent("Home", "full", TWO_SNAP)).toBe("peek");
    expect(keyboardDetent("End", "peek", TWO_SNAP)).toBe("full");
  });
});

describe("isHostKeyDown", () => {
  it("accepts a key that originated on the host itself", () => {
    const host = {};
    expect(isHostKeyDown({ target: host, currentTarget: host })).toBe(true);
  });

  it("ignores a key bubbling up from a descendant field", () => {
    const host = {};
    const dateInput = {};
    expect(isHostKeyDown({ target: dateInput, currentTarget: host })).toBe(false);
  });
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
