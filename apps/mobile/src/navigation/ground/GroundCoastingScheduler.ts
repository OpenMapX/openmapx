import {
  COAST_START_DELAY_MS,
  type CoastAnchor,
  coastedFix,
  cumulativeDistances,
  type FixInput,
  type GroundMobileSession,
  mayCoast,
} from "@openmapx/core/navigation";

/**
 * Keeping the puck moving between fixes, and only where that is honest.
 *
 * A location update arrives about once a second at best, and often far less
 * often. Between them the map would freeze, so the session extrapolates along
 * the route from the last real fix at the last known speed, by the rules the
 * browser follows too (`groundSessionPolicy`). That is a rendering
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

/**
 * How often a coasted position is committed and published. The page draws
 * from snapshots, so a faster cadence would only add database writes.
 */
export const COAST_DISPATCH_MS = 1_000;

/** Whether the session, as committed, may coast while the app has this visibility. */
export function canCoast(
  session: GroundMobileSession,
  visibility: "active" | "inactive" | "background",
): boolean {
  if (visibility !== "active") return false;
  if (session.status !== "active") return false;
  if (!session.payload.progress) return false;
  const anchor = anchorFor(session);
  return (
    anchor !== null &&
    mayCoast({
      offRoute: session.payload.offRoute,
      rerouting: session.payload.reroute.status === "in-flight",
      speedMps: anchor.speedMps,
    })
  );
}

export function anchorFor(session: GroundMobileSession): CoastAnchor | null {
  const anchor = session.payload.coastingAnchor;
  if (!anchor) return null;
  return { alongMeters: anchor.alongMeters, speedMps: anchor.speedMps, atMs: anchor.acceptedAtMs };
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

interface Coast {
  sessionId: string;
  anchor: CoastAnchor;
  geometry: GroundMobileSession["payload"]["startPackage"]["route"]["geometry"];
  cumulative: number[];
}

/**
 * Drives foreground coasting.
 *
 * Every synthetic fix goes through `dispatch`, which is the coordinator's
 * ordinary batch entry point: there is no side channel, so a coasted fix is
 * serialised, compared-and-swapped and persisted exactly like a real one.
 */
export class GroundCoastingScheduler {
  private cancelTick: (() => void) | null = null;
  private coast: Coast | null = null;

  constructor(private readonly ports: SchedulerPorts) {}

  get running(): boolean {
    return this.cancelTick !== null;
  }

  /** Starts, continues or stops the coast to match the session's committed state. */
  sync(
    session: GroundMobileSession | null,
    visibility: "active" | "inactive" | "background",
  ): void {
    const anchor = session && canCoast(session, visibility) ? anchorFor(session) : null;
    if (!session || !anchor) {
      this.stop();
      return;
    }
    // A commit of a coasted fix leaves the anchor as it was, and the coast
    // carries on. A new real fix reanchors and starts a fresh coast rather than
    // continuing an extrapolation from a superseded position.
    if (this.coast?.sessionId === session.sessionId && this.coast.anchor.atMs === anchor.atMs) {
      return;
    }
    this.cancelTick?.();
    const { geometry } = session.payload.startPackage.route;
    this.coast = {
      sessionId: session.sessionId,
      anchor,
      geometry,
      cumulative: cumulativeDistances(geometry),
    };
    this.schedule(anchor.atMs + COAST_START_DELAY_MS - this.ports.now());
  }

  stop(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    this.coast = null;
  }

  private schedule(delayMs: number): void {
    this.cancelTick = this.ports.schedule(this.tick, Math.max(0, delayMs));
  }

  private tick = (): void => {
    this.cancelTick = null;
    const coast = this.coast;
    if (!coast) return;
    const now = this.ports.now();
    const fix = coastedFix(coast.anchor, coast.geometry, coast.cumulative, now);
    if (!fix) {
      if (now - coast.anchor.atMs < COAST_START_DELAY_MS) {
        this.schedule(coast.anchor.atMs + COAST_START_DELAY_MS - now);
        return;
      }
      // The coast is over. Stopping is the honest end: the map freezes where
      // the estimate ran out rather than drifting further.
      this.stop();
      return;
    }
    this.ports.dispatch(fix, { sessionId: coast.sessionId, anchorAtMs: coast.anchor.atMs });
    this.schedule(COAST_DISPATCH_MS);
  };
}
