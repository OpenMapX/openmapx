// @vitest-environment jsdom

import type * as maplibregl from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindMapLongPress, consumeLongPressClick, isTouchClick, LONG_PRESS_MS } from "./mapTouch";

function touch(target: EventTarget, type: string, points: Array<[number, number]>): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", {
    value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
  });
  target.dispatchEvent(event);
}

let container: HTMLDivElement;
let canvas: HTMLCanvasElement;
let marker: HTMLDivElement;
let unbind: () => void;
const onLongPress = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  canvas = document.createElement("canvas");
  marker = document.createElement("div");
  container.append(canvas, marker);
  document.body.append(container);
  const map = {
    getCanvasContainer: () => container,
    getCanvas: () => canvas,
    unproject: ([x, y]: [number, number]) => ({ lng: x, lat: y }),
  } as unknown as maplibregl.Map;
  onLongPress.mockReset();
  unbind = bindMapLongPress(map, onLongPress);
});

afterEach(() => {
  unbind();
  container.remove();
  consumeLongPressClick();
  vi.useRealTimers();
});

describe("bindMapLongPress", () => {
  it("fires where a single finger rested", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0][0]).toEqual([30, 40]);
  });

  it("tolerates a little jitter", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    touch(canvas, "touchmove", [[34, 43]]);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => void]>([
    ["the finger pans away", () => touch(canvas, "touchmove", [[60, 40]])],
    [
      "a second finger joins",
      () =>
        touch(canvas, "touchmove", [
          [30, 40],
          [80, 90],
        ]),
    ],
    ["the finger lifts", () => touch(canvas, "touchend", [])],
  ])("does not fire when %s", (_name, interrupt) => {
    touch(canvas, "touchstart", [[30, 40]]);
    interrupt();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("ignores a press on a marker above the canvas", () => {
    touch(marker, "touchstart", [[30, 40]]);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("swallows the one click a long-press may leave behind", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(consumeLongPressClick()).toBe(true);
    expect(consumeLongPressClick()).toBe(false);
  });
});

describe("isTouchClick", () => {
  it("trusts a click that says it came from touch", () => {
    expect(isTouchClick({ pointerType: "touch" })).toBe(true);
    expect(isTouchClick({ sourceCapabilities: { firesTouchEvents: true } })).toBe(true);
  });

  it("treats a click right after a touch on the map as that touch (Safari)", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    touch(canvas, "touchend", []);
    expect(isTouchClick({})).toBe(true);
  });

  it("treats a mouse click long after any touch as a mouse click", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    vi.advanceTimersByTime(5000);
    expect(isTouchClick({ pointerType: "mouse" })).toBe(false);
  });
});
