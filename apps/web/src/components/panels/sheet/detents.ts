/** The three positions a mobile sheet can rest at. */
export type Detent = "peek" | "mid" | "full";

export interface DetentConfig {
  /** Fallback peek height used until the peek subtree has been measured. */
  peek: string;
  /** Middle resting height. Use dvh — `%` in --snap is relative to max height. */
  mid: string;
  /** Sheet max height. This, not the top snap, is what leaves a map strip visible. */
  maxHeight: string;
  /** Which detent the sheet opens at. Opening at full is not supported. */
  initial: Exclude<Detent, "full">;
}

export interface SnapSlot {
  snap: string;
  className?: string;
}

const MAX_HEIGHT = "94dvh";

export const PLACE_DETENTS: DetentConfig = {
  peek: "180px",
  mid: "52dvh",
  maxHeight: MAX_HEIGHT,
  initial: "mid",
};

export const DIRECTIONS_DETENTS: DetentConfig = {
  peek: "180px",
  mid: "42dvh",
  maxHeight: MAX_HEIGHT,
  initial: "mid",
};

export const LIST_DETENTS: DetentConfig = {
  peek: "180px",
  mid: "55dvh",
  maxHeight: MAX_HEIGHT,
  initial: "mid",
};

/**
 * Snap indices as the library reports them: 0 is its dismissed position, then
 * one index per snap counting from the bottom up — the element list is
 * reversed relative to the DOM.
 */
export const DETENT_INDEX: Record<Detent, number> = { peek: 1, mid: 2, full: 3 };

export function detentFromSnapIndex(index: number): Detent {
  if (index >= DETENT_INDEX.full) return "full";
  if (index >= DETENT_INDEX.mid) return "mid";
  return "peek";
}

/**
 * Builds the `slot="snap"` descriptors, largest first.
 *
 * Order matters twice over: the library reverses the assigned elements, so the
 * `top` class must be on the first one in the DOM, and without a top snap it
 * treats the sheet's own top edge as an extra snap above the declared ones —
 * in expand-to-scroll mode the content scroller then only unlocks at that
 * unreachable position.
 */
export function snapSlots(config: DetentConfig, peekPx: number | null): SnapSlot[] {
  const peek = peekPx != null && peekPx > 0 ? `${Math.round(peekPx)}px` : config.peek;
  const initial = (detent: Exclude<Detent, "full">) =>
    config.initial === detent ? { className: "initial" } : {};
  return [
    { snap: "100%", className: "top" },
    { snap: config.mid, ...initial("mid") },
    { snap: peek, ...initial("peek") },
  ];
}
