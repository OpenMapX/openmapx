/**
 * Bounded, coalesced scheduling for a viewport-bbox refetch that is fed by a
 * MapLibre `moveend` stream. Plain camera panning fires `moveend` once per
 * gesture, but a followed navigation camera fires it once per animation frame
 * (up to ~60/s) for the whole duration of a drive. A naive "debounce that
 * resets on every event" scheduler never settles under that load — the
 * refetch it is meant to eventually run simply never happens — and even when
 * it does fire it churns a `clearTimeout`/`setTimeout` pair on the hot path.
 *
 * This module separates the `moveend` handler (which must stay a flag flip)
 * from the actual "should we refetch" decision (a coalesced evaluation that
 * runs no more than once per `evalThrottleMs`, and reads the viewport itself
 * exactly once per run — never a value captured earlier).
 */

export interface ViewportBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ViewportFetchSchedulerOptions {
  /**
   * How long fetched data may go without a refresh even with zero movement —
   * the caller's provider-freshness contract, not a UI debounce.
   */
  freshnessDeadlineMs: number;
  /**
   * Fraction of the last-fetched viewport's width/height added as slack on
   * every side before a pan/zoom is judged to have left it. Callers own the
   * value (and its justification) since the right amount of slack is a
   * property of what's being fetched, not of the scheduling policy itself.
   */
  paddingFactor: number;
  /** Minimum spacing between evaluations while `markDirty` keeps firing. */
  evalThrottleMs?: number;
  /** Reads the current viewport. Called only from a coalesced evaluation. */
  getViewport: () => ViewportBox;
  /** Invoked when an evaluation decides a refetch is due. */
  onDue: () => void;
  now?: () => number;
  /**
   * Opaque on purpose: this module builds for both the browser (where
   * `setTimeout` returns a `number`) and Node (where `@types/node` overloads
   * the same global to return a `Timeout`). `apps/api`'s tsconfig sees both
   * declarations at once, which makes `ReturnType<typeof setTimeout>` resolve
   * to an unstable union — pinning the handle type to `unknown` here sidesteps
   * that instead of fighting it.
   */
  setTimeout?: (handler: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface ViewportFetchScheduler {
  /**
   * The `moveend` hot path. In the common case (an evaluation is already
   * pending) this is a single comparison — no timer churn, no `getBounds()`,
   * no state update, no request.
   */
  markDirty: () => void;
  /**
   * Tell the scheduler a fetch was just initiated for `viewport`, so future
   * evaluations compare against it and the next freshness deadline is armed
   * from `at` (default: now). Callers should call this for every fetch they
   * initiate, not only ones the scheduler itself asked for via `onDue` — an
   * immediate fetch on mount or a filter change establishes the baseline the
   * same way a scheduled one does.
   */
  recordFetch: (viewport: ViewportBox, at?: number) => void;
  /**
   * Cancel any pending evaluation/freshness timers. Idempotent, and safe to
   * keep using the scheduler afterward: `markDirty`/`recordFetch` re-arm
   * whatever they need. Callers should call this whenever the thing driving
   * `moveend` goes away (unmount, hidden layer, style swap) so an idle map
   * never holds a live timer.
   */
  dispose: () => void;
}

const DEFAULT_EVAL_THROTTLE_MS = 5000;

/**
 * Whether `current` sits fully inside `reference` padded by `paddingFactor`
 * of `reference`'s own width/height on every side. Plain lng/lat comparison —
 * matches the rest of this integration, which does not special-case the
 * antimeridian for viewport bboxes either.
 */
export function isViewportContained(
  current: ViewportBox,
  reference: ViewportBox,
  paddingFactor: number,
): boolean {
  const padX = (reference.east - reference.west) * paddingFactor;
  const padY = (reference.north - reference.south) * paddingFactor;
  return (
    current.west >= reference.west - padX &&
    current.east <= reference.east + padX &&
    current.south >= reference.south - padY &&
    current.north <= reference.north + padY
  );
}

/** Default `setTimeout`, its return value erased to the module's opaque handle type. */
function defaultScheduleTimeout(handler: () => void, delayMs: number): unknown {
  return setTimeout(handler, delayMs);
}

/** Default `clearTimeout`, recovering the concrete handle type it actually needs. */
function defaultCancelTimeout(handle: unknown): void {
  clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
}

export function createViewportFetchScheduler(
  options: ViewportFetchSchedulerOptions,
): ViewportFetchScheduler {
  const {
    freshnessDeadlineMs,
    paddingFactor,
    evalThrottleMs = DEFAULT_EVAL_THROTTLE_MS,
    getViewport,
    onDue,
    now = Date.now,
    setTimeout: scheduleTimeout = defaultScheduleTimeout,
    clearTimeout: cancelTimeout = defaultCancelTimeout,
  } = options;

  let evalTimer: unknown = null;
  let freshnessTimer: unknown = null;
  let lastEvalAt = 0;
  let lastFetchViewport: ViewportBox | null = null;
  let lastFetchAt = 0;

  function performEvaluation(): void {
    lastEvalAt = now();
    const viewport = getViewport();
    const freshnessDue = now() - lastFetchAt >= freshnessDeadlineMs;
    const outOfBounds =
      !lastFetchViewport || !isViewportContained(viewport, lastFetchViewport, paddingFactor);
    if (freshnessDue || outOfBounds) onDue();
  }

  function armFreshnessTimer(): void {
    if (freshnessTimer !== null) cancelTimeout(freshnessTimer);
    freshnessTimer = scheduleTimeout(() => {
      freshnessTimer = null;
      performEvaluation();
    }, freshnessDeadlineMs);
  }

  return {
    markDirty() {
      // The one branch this hot path takes: an evaluation is already on the
      // way, so there is nothing left to do. Only the first `moveend` after
      // an idle period reaches the `setTimeout` below.
      if (evalTimer !== null) return;
      const delay = Math.max(0, evalThrottleMs - (now() - lastEvalAt));
      evalTimer = scheduleTimeout(() => {
        evalTimer = null;
        performEvaluation();
      }, delay);
    },
    recordFetch(viewport, at = now()) {
      lastFetchViewport = viewport;
      lastFetchAt = at;
      armFreshnessTimer();
    },
    dispose() {
      if (evalTimer !== null) {
        cancelTimeout(evalTimer);
        evalTimer = null;
      }
      if (freshnessTimer !== null) {
        cancelTimeout(freshnessTimer);
        freshnessTimer = null;
      }
    },
  };
}
