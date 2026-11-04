// @vitest-environment jsdom

import type * as maplibregl from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindMapLongPress, cameFromTouch, consumeLongPressClick, LONG_PRESS_MS } from "./mapTouch";

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
  touch(canvas, "touchend", []);
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
    touch(canvas, "touchend", []);
    expect(consumeLongPressClick()).toBe(true);
    expect(consumeLongPressClick()).toBe(false);
  });

  it("swallows it however long the finger was held, counting from the lift", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    vi.advanceTimersByTime(LONG_PRESS_MS + 3000);
    touch(canvas, "touchend", []);
    vi.advanceTimersByTime(20);
    expect(consumeLongPressClick()).toBe(true);
  });

  it("lets the next tap through when the long-press left no click behind", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    touch(canvas, "touchend", []);
    touch(canvas, "touchstart", [[30, 40]]);
    touch(canvas, "touchend", []);
    expect(consumeLongPressClick()).toBe(false);
  });

  it("leaves a plain tap's click alone", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    vi.advanceTimersByTime(100);
    touch(canvas, "touchend", []);
    expect(consumeLongPressClick()).toBe(false);
  });
});

describe("cameFromTouch", () => {
  it("trusts an event that says it came from touch", () => {
    expect(cameFromTouch({ pointerType: "touch" })).toBe(true);
    expect(cameFromTouch({ sourceCapabilities: { firesTouchEvents: true } })).toBe(true);
  });

  it("treats a click right after a touch on the map as that touch (Safari)", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    touch(canvas, "touchend", []);
    expect(cameFromTouch({})).toBe(true);
  });

  it("treats MapLibre's long-press contextmenu, a plain MouseEvent, as touch while the finger is down", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    vi.advanceTimersByTime(5000);
    expect(cameFromTouch(new MouseEvent("contextmenu", { button: 2 }))).toBe(true);
  });

  it("sees a touch that never reached the map", () => {
    touch(document.body, "touchstart", [[30, 40]]);
    expect(cameFromTouch(new MouseEvent("contextmenu"))).toBe(true);
  });

  it("treats a mouse event long after any touch as the mouse", () => {
    touch(canvas, "touchstart", [[30, 40]]);
    touch(canvas, "touchend", []);
    vi.advanceTimersByTime(5000);
    expect(cameFromTouch({ pointerType: "mouse" })).toBe(false);
    expect(cameFromTouch(new MouseEvent("contextmenu", { button: 2 }))).toBe(false);
  });
});
