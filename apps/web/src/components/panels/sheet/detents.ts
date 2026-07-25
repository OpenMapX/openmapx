/** The three positions a mobile sheet can rest at. */
export type Detent = "peek" | "mid" | "full";

export interface DetentConfig {
  /** Fallback peek height used until the peek subtree has been measured. */
  peek: string;
  /**
   * Middle resting height. Use dvh — `%` in --snap is relative to max height.
   * Omit for a two-snap sheet (peek and full only, no intermediate rest) —
   * the navigation sheet, whose two states are content-measured rather than
   * viewport fractions.
   */
  mid?: string;
  /** Sheet max height. This, not the top snap, is what leaves a map strip visible. */
  maxHeight: string;
  /** Which detent the sheet opens at. Opening at full is not supported. */
  initial: Exclude<Detent, "full">;
}

export interface SnapSlot {
  snap: string;
  className?: string;
  /**
   * Stable identity for this marker, independent of its measured `snap`
   * length. Used as the React key for the rendered marker so a peek/mid
   * length change (e.g. the navigation sheet's header rewrapping) updates the
   * marker in place instead of remounting the one the browser is currently
   * snapped to. "top" is the library's own extra snap above the declared
   * detents, not a real `Detent`.
   */
  detent: "top" | Detent;
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
 * reversed relative to the DOM. `mid` is only present when the config
 * declares one; a two-snap sheet numbers straight from peek to full.
 */
export interface DetentIndex {
  peek: number;
  mid?: number;
  full: number;
}

export function detentIndex(config: DetentConfig): DetentIndex {
  const mid = config.mid != null ? 2 : undefined;
  return { peek: 1, mid, full: mid != null ? 3 : 2 };
}

export function detentFromSnapIndex(index: number, config: DetentConfig): Detent {
  const idx = detentIndex(config);
  if (index >= idx.full) return "full";
  if (idx.mid != null && index >= idx.mid) return "mid";
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
  // Clamp against the middle detent: unlike `--snap: 100%`, a px value never
  // resolves against the host height, so an unclamped measurement (a tall
  // panel can run to several thousand px) makes the peek detent unreachable
  // and, past roughly 188dvh, inflates `host.scrollHeight` enough to break
  // the visible-height derivation in sheetMetrics.ts. The ceiling is `mid`
  // rather than a fixed fraction so peek can never meet or overtake it —
  // surfaces set their own mid, and the smallest today is well under half
  // the viewport. A two-snap config has no mid to clamp against — its peek
  // is already an exact content measurement, not a preview clipped shorter
  // than the rest of the content.
  const peek =
    peekPx != null && peekPx > 0
      ? config.mid != null
        ? `min(${Math.round(peekPx)}px, ${config.mid})`
        : `${Math.round(peekPx)}px`
      : config.peek;
  const initial = (detent: Exclude<Detent, "full">) =>
    config.initial === detent ? { className: "initial" } : {};
  const slots: SnapSlot[] = [{ snap: "100%", className: "top", detent: "top" }];
  if (config.mid != null) slots.push({ snap: config.mid, detent: "mid", ...initial("mid") });
  slots.push({ snap: peek, detent: "peek", ...initial("peek") });
  return slots;
}
