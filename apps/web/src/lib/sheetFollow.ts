"use client";

import { useSyncExternalStore } from "react";
import type { MapFooterBox } from "@/lib/mapFooterCenter";
import { subscribeMobileFooterSurfaces, topMobileFooterSurface } from "@/lib/mobileFooterSurface";

/**
 * Map chrome that rides the mobile bottom sheet — the footer, the legend tab,
 * the map controls, the scale and the speed-limit badge — follows the sheet's
 * scroll position through a CSS scroll-driven animation instead of a position
 * written from script.
 *
 * The sheet moves by native scrolling, which the browser runs on its
 * compositor. A position set from a scroll listener lands on the main thread
 * at least a frame later, and later still while the map renders, so a fast
 * drag left the chrome visibly trailing the sheet. A scroll-driven `translate`
 * runs on the compositor with the scroll itself. Script only describes the
 * mapping, which changes when the sheet's geometry does, not while it moves.
 *
 * The driving sheet's host is the named scroll timeline; `timeline-scope` on
 * the root (globals.css) makes it visible to chrome anywhere in the page, and
 * the `omx-sheet-follow` keyframes there translate a follower up by
 * `--omx-sheet-follow-travel` across its animation range.
 *
 * Browsers without scroll-driven animations get no track and keep positioning
 * the chrome from the published sheet height.
 */
export const SHEET_FOLLOW_TIMELINE = "--omx-sheet-follow";
const SHEET_FOLLOW_KEYFRAMES = "omx-sheet-follow";
const SHEET_FOLLOW_TRAVEL = "--omx-sheet-follow-travel";
// MUI's `down("sm")`, which decides whether sheets and the footer surface exist.
const MOBILE_QUERY = "(max-width: 599.95px)";

/** The driving sheet's geometry, constant while it is dragged. */
export interface SheetFollowTrack {
  /** Host scroll offset at which the sheet's visible height is zero. */
  scrollStart: number;
  /** Visible sheet height beyond which map chrome stops following. */
  cap: number;
  /** How far the sheet's bottom sits above the layout viewport's (keyboard lift). */
  lift: number;
  /** Layout-viewport pixels hidden below the visual viewport, which the footer stays above. */
  floor: number;
}

/**
 * Where a follower sits, in px from the viewport bottom, as a function of the
 * followed height `f` (the visible sheet height, capped at the track's cap):
 * `clamp(min, offset + f, max)`.
 */
export interface SheetFollowPlacement {
  offset: number;
  min?: number;
  max?: number;
}

/** A follower's static position plus the scroll range over which it rises by `travel`. */
export interface SheetFollowPlan {
  /** Position with the sheet at zero height. */
  base: number;
  /** Host scroll offsets bounding the animation range. */
  start: number;
  end: number;
  travel: number;
}

let supported: boolean | null = null;

export function sheetFollowSupported(): boolean {
  if (supported == null) {
    supported =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports(`animation-timeline: ${SHEET_FOLLOW_TIMELINE}`) &&
      CSS.supports(`timeline-scope: ${SHEET_FOLLOW_TIMELINE}`) &&
      CSS.supports("animation-range: 0px 1px") &&
      CSS.supports("animation-duration: auto") &&
      CSS.supports("translate: 0 1px");
  }
  return supported;
}

/** Test hook: forget the cached support decision. */
export function resetSheetFollowSupport(): void {
  supported = null;
}

let track: SheetFollowTrack | null = null;
let timelineHost: HTMLElement | null = null;
const listeners = new Set<() => void>();
let stopDriver: (() => void) | null = null;

function claimTimeline(host: HTMLElement | null) {
  if (timelineHost === host) return;
  timelineHost?.style.removeProperty("scroll-timeline");
  host?.style.setProperty("scroll-timeline", `${SHEET_FOLLOW_TIMELINE} y`);
  timelineHost = host;
}

function measure(): SheetFollowTrack | null {
  const surface = window.matchMedia(MOBILE_QUERY).matches ? topMobileFooterSurface() : null;
  claimTimeline(surface?.host ?? null);
  if (!surface) return null;
  const { host } = surface;
  const vv = window.visualViewport;
  const viewportBottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight);
  return {
    // `visibleSheetHeight`: clientHeight - (maxScroll - scrollTop), so the
    // height is zero at maxScroll - clientHeight and rises 1px per scrolled px.
    scrollStart: host.scrollHeight - 2 * host.clientHeight,
    cap: surface.followCap,
    lift: Math.max(0, window.innerHeight - surface.bottom),
    floor: Math.max(0, window.innerHeight - viewportBottom),
  };
}

function sameTrack(a: SheetFollowTrack | null, b: SheetFollowTrack | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.scrollStart === b.scrollStart && a.cap === b.cap && a.lift === b.lift && a.floor === b.floor
  );
}

function refresh() {
  const next = measure();
  if (sameTrack(track, next)) return;
  track = next;
  for (const listener of listeners) listener();
}

function startDriver(): () => void {
  const mobile = window.matchMedia(MOBILE_QUERY);
  const vv = window.visualViewport;
  const unsubscribe = subscribeMobileFooterSurfaces(refresh);
  mobile.addEventListener("change", refresh);
  window.addEventListener("resize", refresh);
  vv?.addEventListener("resize", refresh);
  refresh();
  return () => {
    unsubscribe();
    mobile.removeEventListener("change", refresh);
    window.removeEventListener("resize", refresh);
    vv?.removeEventListener("resize", refresh);
    claimTimeline(null);
    track = null;
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Unsupported browsers never get a track, so there is nothing to drive.
  if (sheetFollowSupported()) stopDriver ??= startDriver();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopDriver?.();
    stopDriver = null;
  };
}

const getSnapshot = () => track;
const getServerSnapshot = (): SheetFollowTrack | null => null;

/**
 * The driving sheet's track, or null when no sheet is on screen or the browser
 * cannot run the follow on the compositor; followers then position from the
 * published sheet height as before.
 */
export function useSheetFollowTrack(): SheetFollowTrack | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function planSheetFollow(
  { scrollStart, cap }: SheetFollowTrack,
  { offset, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY }: SheetFollowPlacement,
): SheetFollowPlan {
  const ceiling = Math.max(min, max);
  const base = Math.min(Math.max(offset, min), ceiling);
  // Followed heights over which the position moves: below `from` the floor
  // holds it, above `to` the ceiling or the cap does.
  const from = Math.max(0, min - offset);
  const to = Math.max(from, Math.min(cap, ceiling - offset));
  return { base, start: scrollStart + from, end: scrollStart + to, travel: to - from };
}

/**
 * Standing `gap` px above the footer while it rides the sheet's top edge, or
 * null while the footer is docked inside the sheet and the sheet edge itself
 * is what to stand on.
 */
export function onSheetFooter(
  { lift, floor }: SheetFollowTrack,
  footer: MapFooterBox,
  gap: number,
): SheetFollowPlacement | null {
  if (footer.docked) return null;
  return { offset: lift + footer.height + gap, min: floor + footer.height + gap };
}

/**
 * `gap` px above the footer while it rides the sheet, or above the sheet edge
 * once the footer docks inside it, and never below `floor`.
 */
export function planAboveFooter(
  track: SheetFollowTrack,
  footer: MapFooterBox,
  gap: number,
  floor = Number.NEGATIVE_INFINITY,
): SheetFollowPlan {
  const stand = onSheetFooter(track, footer, gap) ?? { offset: gap };
  return planSheetFollow(track, {
    offset: stand.offset,
    min: Math.max(floor, stand.min ?? Number.NEGATIVE_INFINITY),
  });
}

/** The scroll-driven animation that moves a follower from `base` with the sheet. */
export function sheetFollowSx(plan: SheetFollowPlan | null): Record<string, string> {
  if (!plan || !(plan.travel > 0)) return {};
  return {
    animationName: SHEET_FOLLOW_KEYFRAMES,
    animationDuration: "auto",
    animationTimingFunction: "linear",
    animationFillMode: "both",
    animationTimeline: SHEET_FOLLOW_TIMELINE,
    animationRange: `${plan.start}px ${plan.end}px`,
    [SHEET_FOLLOW_TRAVEL]: `${plan.travel}px`,
  };
}
