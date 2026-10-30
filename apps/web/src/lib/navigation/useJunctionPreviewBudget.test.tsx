import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { installMeasuredLayout } from "@/test/measuredLayout";
import { useJunctionPreviewBudget } from "./useJunctionPreviewBudget";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

it("reserves measured controls and following banner content even when the photo pushes the bottom below the shell", () => {
  const shell = document.createElement("div");
  const banner = document.createElement("div");
  const junction = document.createElement("div");
  const bottom = document.createElement("div");
  const speedLimit = document.createElement("div");
  const panel = document.createElement("div");
  const bottomHeader = document.createElement("div");
  panel.style.marginBottom = "16px";
  panel.append(bottomHeader);
  let shellHeight = 844;
  let bottomTop = 1000;
  let tail = 24;
  const layout = installMeasuredLayout((el) => {
    if (el === shell) return new DOMRect(0, 0, 390, shellHeight);
    if (el === junction) return new DOMRect(0, 150, 358, 500);
    if (el === banner) return new DOMRect(0, 0, 390, 650 + tail);
    if (el === bottom) return new DOMRect(0, bottomTop, 390, 10);
    if (el === speedLimit) return new DOMRect(0, 0, 64, 64);
    if (el === bottomHeader) return new DOMRect(0, 0, 390, 96);
    return new DOMRect();
  });
  restore = layout.restore;
  const { result, rerender } = renderHook(
    (isMobile: boolean) =>
      useJunctionPreviewBudget({
        shell,
        banner,
        junction,
        bottom,
        speedLimit,
        bottomHeader,
        isMobile,
        sheetClearance: 96,
        speedLimitRidesSheet: false,
        sheetOccupiedHeight: 96,
        mobilePanelPending: false,
      }),
    { initialProps: false },
  );
  // 844 - (64 + 96 + 16) - 150 - 24; affected bottomTop=1000 cannot certify a fit.
  expect(result.current).toBe(494);
  act(() => {
    layout.resize();
    layout.resize();
  });
  expect(result.current).toBe(494);
  act(() => {
    shellHeight = 600;
    layout.resize();
  });
  expect(result.current).toBe(250);
  act(() => {
    shellHeight = 1000;
    bottomTop = 800;
    tail = 60;
    layout.resize();
  });
  expect(result.current).toBe(590);
  speedLimit.style.marginBottom = "96px";
  rerender(true);
  // Actual sheet clearance is included once in the speed-limit wrapper margin.
  expect(result.current).toBe(590);
});

it("reserves the measured mobile sheet even when no speed badge is rendered", () => {
  const shell = document.createElement("div");
  const banner = document.createElement("div");
  const junction = document.createElement("div");
  const bottom = document.createElement("div");
  const layout = installMeasuredLayout((el) =>
    el === shell
      ? new DOMRect(0, 0, 390, 844)
      : el === junction
        ? new DOMRect(0, 150, 358, 250)
        : el === banner
          ? new DOMRect(0, 0, 390, 416)
          : new DOMRect(0, 844, 390, 0),
  );
  restore = layout.restore;
  const { result, rerender } = renderHook(
    ({ pending, occupied }: { pending: boolean; occupied: number }) =>
      useJunctionPreviewBudget({
        shell,
        banner,
        junction,
        bottom,
        speedLimit: null,
        bottomHeader: null,
        isMobile: true,
        sheetClearance: 120,
        speedLimitRidesSheet: false,
        sheetOccupiedHeight: occupied,
        mobilePanelPending: pending,
      }),
    { initialProps: { pending: true, occupied: 120 } },
  );
  expect(result.current).toBeNull();
  rerender({ pending: false, occupied: 120 });
  expect(result.current).toBe(558);
  // Expanded sheet exceeds the intentionally capped badge-follow distance.
  rerender({ pending: false, occupied: 700 });
  expect(result.current).toBe(0);
  rerender({ pending: false, occupied: 120 });
  expect(result.current).toBe(558);
});

it("reserves the sheet clearance above a speed badge that rides the sheet by translation", () => {
  const shell = document.createElement("div");
  const banner = document.createElement("div");
  const junction = document.createElement("div");
  const bottom = document.createElement("div");
  const speedLimit = document.createElement("div");
  const layout = installMeasuredLayout((el) => {
    if (el === shell) return new DOMRect(0, 0, 390, 844);
    if (el === junction) return new DOMRect(0, 150, 358, 500);
    if (el === banner) return new DOMRect(0, 0, 390, 650);
    if (el === bottom) return new DOMRect(0, 1000, 390, 10);
    if (el === speedLimit) return new DOMRect(0, 0, 64, 64);
    return new DOMRect();
  });
  restore = layout.restore;
  const { result, rerender } = renderHook(
    (speedLimitRidesSheet: boolean) =>
      useJunctionPreviewBudget({
        shell,
        banner,
        junction,
        bottom,
        speedLimit,
        bottomHeader: null,
        isMobile: true,
        sheetClearance: 120,
        speedLimitRidesSheet,
        sheetOccupiedHeight: 120,
        mobilePanelPending: false,
      }),
    { initialProps: false },
  );
  // A margin badge has no 120px margin in this layout, so the clearance alone counts.
  expect(result.current).toBe(844 - 120 - 150);
  // Translated, it stands on the sheet: its own 64px sit above the clearance.
  rerender(true);
  expect(result.current).toBe(844 - (64 + 120) - 150);
});
