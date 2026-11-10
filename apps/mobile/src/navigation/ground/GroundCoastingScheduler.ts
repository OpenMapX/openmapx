import {
  coastState,
  cumulativeDistances,
  type FixInput,
  type GroundMobileSession,
  positionAt,
} from "@openmapx/core/navigation";

/**
 * Keeping the puck moving between fixes — and only where that is honest.
 *
 * A location update arrives about once a second at best, and often far less
 * often. Between them the map would freeze, so the shell extrapolates along the
 * route from the last real fix at the last known speed. That is a rendering
 * convenience, not a measurement, and it is bounded accordingly.
 *
 * What it deliberately does **not** do is pretend a JavaScript timer runs while
 * the operating system has suspended the app. Coasting is foreground-only. In
 * the background, position comes from operating-system callbacks or it does not
 * come at all, and the next real fix places the user wherever they turned out
 * to be.
 *
 * The anchor is the last real fix's position along the route, persisted with
 * the session (`coastingAnchor`). A coasted fix advances the shown progress but
 * never the anchor or the last accepted fix, so every estimate is measured from
 * a real position and nothing synthetic is ever treated as one.
 */

/** How long to wait after a real fix before extrapolating at all. */
export const COAST_START_DELAY_MS = 3_000;
/** Longest a coast may run before it is simply no longer credible. */
export const MAX_COAST_MS = 120_000;
/** Furthest a coast may travel, whatever the speed suggests. */
export const MAX_COAST_METERS = 3_000;
/** Visual cadence while foregrounded, matching the browser. */
export const COAST_TICK_MS = 250;
/** How often a coasted position is actually persisted. */
export const COAST_PERSIST_MS = 1_000;

export interface CoastAnchor {
  alongMeters: number;
  speedMps: number;
  atMs: number;
}

/**
 * Whether a session is in a state where extrapolating is defensible.
 *
 * Each refusal is a case where a synthetic point would be a claim rather than an
 * estimate: off route there is no line to follow, stationary there is no motion
 * to continue, and while rerouting the route itself is about to change.
 */
export function canCoast(
  session: GroundMobileSession,
  visibility: "active" | "inactive" | "background",
): boolean {
  if (visibility !== "active") return false;
  if (session.status !== "active") return false;
  if (session.permissionMode === "foreground-only" && visibility !== "active") return false;
  if (session.payload.offRoute) return false;
  if (session.payload.reroute.status === "in-flight") return false;
  if (!session.payload.progress) return false;

  const anchor = anchorFor(session);
  return anchor !== null && anchor.speedMps > 0;
}

export function anchorFor(session: GroundMobileSession): CoastAnchor | null {
  const anchor = session.payload.coastingAnchor;
  if (!anchor) return null;
  return { alongMeters: anchor.alongMeters, speedMps: anchor.speedMps, atMs: anchor.acceptedAtMs };
}

/**
 * The synthetic fix for a given moment, or nothing when the coast has run out.
 *
 * The accuracy of 1 metre is an internal marker meaning "exactly on the route",
 * not a measurement. It never reaches diagnostics as an accuracy bucket, and the
 * fix is flagged `coasted` so the engine and the persisted record both know it
 * was estimated.
 */
export function coastFixAt(
  session: GroundMobileSession,
  anchor: CoastAnchor,
  atMs: number,
): FixInput | null {
  const elapsedMs = atMs - anchor.atMs;
  if (elapsedMs < COAST_START_DELAY_MS) return null;
  if (elapsedMs > MAX_COAST_MS) return null;

  const geometry = session.payload.startPackage.route.geometry;
  const cumulative = cumulativeDistances(geometry);
  const coast = coastState(anchor.alongMeters, anchor.speedMps, elapsedMs, {
    startAfterMs: COAST_START_DELAY_MS,
    maxCoastMs: MAX_COAST_MS,
    maxCoastMeters: MAX_COAST_METERS,
    routeLengthMeters: cumulative[cumulative.length - 1] ?? 0,
  });

  if (!coast.coasting) return null;
  // The linear deceleration curve reaches zero at the coast limit, so a coast
  // that has stopped moving has nothing further to say.
  if (coast.speedMps <= 0) return null;

  const position = positionAt(geometry, cumulative, coast.alongMeters);

  return {
    coords: position.point,
    accuracy: 1,
    speed: coast.speedMps,
    heading: position.bearing,
    timestampMs: atMs,
    coasted: true,
  };
}

/** Which session and which real fix a coasted fix was estimated from. */
export interface CoastOrigin {
  sessionId: string;
  anchorAtMs: number;
}

export interface SchedulerPorts {
  now(): number;
  /** Schedules the next tick; returns a function that cancels it. */
  schedule(callback: () => void, delayMs: number): () => void;
  /**
   * Delivers a synthetic fix through the same path a real one takes. The
   * receiver drops it if the session has moved on from `origin` since.
   */
  dispatch(fix: FixInput, origin: CoastOrigin): void;
}

/**
 * Drives foreground coasting.
 *
 * Every synthetic fix goes through `dispatch`, which is the coordinator's
 * ordinary batch entry point — there is no side channel, so a coasted fix is
 * serialised, compared-and-swapped and persisted exactly like a real one.
 */
export class GroundCoastingScheduler {
  private cancelTick: (() => void) | null = null;
  private anchor: CoastAnchor | null = null;
  private session: GroundMobileSession | null = null;
  private lastDispatchAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly ports: SchedulerPorts) {}

  get running(): boolean {
    return this.cancelTick !== null;
  }

  /** Starts, restarts or stops the coast to match the session's current state. */
  sync(
    session: GroundMobileSession | null,
    visibility: "active" | "inactive" | "background",
  ): void {
    if (!session || !canCoast(session, visibility)) {
      this.stop();
      return;
    }
    const anchor = anchorFor(session);
    if (!anchor) {
      this.stop();
      return;
    }

    // A new real fix reanchors and starts a fresh coast, rather than continuing
    // an old extrapolation from a position that has been superseded.
    const reanchored =
      this.session?.sessionId !== session.sessionId || this.anchor?.atMs !== anchor.atMs;
    this.session = session;
    this.anchor = anchor;
    if (reanchored) this.lastDispatchAtMs = Number.NEGATIVE_INFINITY;
    if (!this.cancelTick) this.tick();
  }

  stop(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    this.anchor = null;
    this.session = null;
    this.lastDispatchAtMs = Number.NEGATIVE_INFINITY;
  }

  private tick = (): void => {
    this.cancelTick = null;
    const session = this.session;
    const anchor = this.anchor;
    if (!session || !anchor) return;

    const now = this.ports.now();
    const elapsedMs = now - anchor.atMs;

    if (elapsedMs < COAST_START_DELAY_MS) {
      // Not yet, rather than over: the fix is recent enough that extrapolating
      // would add nothing, so look again when it is old enough.
      this.cancelTick = this.ports.schedule(this.tick, COAST_START_DELAY_MS - elapsedMs);
      return;
    }

    const synthetic = coastFixAt(session, anchor, now);
    if (!synthetic) {
      // The coast is over. Stopping is the honest end: the map freezes where
      // the estimate ran out rather than drifting further.
      this.stop();
      return;
    }

    // The visual cadence is faster than the persisted one, so a redraw does not
    // cost a database write.
    if (now - this.lastDispatchAtMs >= COAST_PERSIST_MS) {
      this.lastDispatchAtMs = now;
      this.ports.dispatch(synthetic, { sessionId: session.sessionId, anchorAtMs: anchor.atMs });
    }
    this.cancelTick = this.ports.schedule(this.tick, COAST_TICK_MS);
  };
}
