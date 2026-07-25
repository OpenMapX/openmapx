import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
