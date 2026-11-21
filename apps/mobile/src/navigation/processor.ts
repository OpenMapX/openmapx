import type {
  FixInput,
  MobileNavigationSession,
  NavigationStartPackage,
  WebToNativeMessage,
} from "@openmapx/core/navigation";
import type { ScheduledAlertInput, SessionEffect } from "../storage/SessionRepository";
import type { RefreshOutcome } from "./transit/TransitRefreshService";

/** A walking route for a transit leg, as the page sent it and the bridge validated it. */
export type WalkRepairRoute = Extract<
  WebToNativeMessage,
  { type: "transit.walk-route" }
>["payload"]["route"];

/**
 * The mode boundary.
 *
 * Ground and transit differ in almost everything that matters — what a fix
 * means, when a cue is due, what "off course" is, whether a schedule can stand
 * in for a signal — and nothing about that belongs in the coordinator. A
 * processor decides *what the session becomes*; the coordinator decides *when*
 * and persists the result.
 *
 * Processors are pure with respect to storage: they receive a session and
 * return the next one. They never write, speak, notify or fetch. That is what
 * lets the same code run identically against a recorded trace and a live device.
 */

export interface ProcessorMutation {
  session: MobileNavigationSession;
  effects?: SessionEffect[];
  alerts?: readonly ScheduledAlertInput[];
}

export type ProcessorPreparation =
  | { ok: true; session: MobileNavigationSession }
  | { ok: false; code: string };

export interface NavigationProcessor<K extends "ground" | "transit"> {
  readonly kind: K;

  /**
   * Whether a wake-up carrying no usable position still deserves a tick.
   *
   * True for transit, where freshness must still change while the rider is
   * underground and producing nothing. False for ground, where position is the
   * only evidence there is — ticking without one would advance nothing and
   * commit a revision saying so.
   */
  readonly needsScheduleTicks: boolean;

  /** Validates a start package and builds revision 1 of a `preparing` session. */
  prepare(
    startPackage: Extract<NavigationStartPackage, { kind: K }>,
    context: { sessionId: string; nowMs: number; permissionMode: "background" | "foreground-only" },
  ): ProcessorPreparation;

  /** Advances the session by one committed revision for a sanitised batch. */
  processFixes(
    session: Extract<MobileNavigationSession, { kind: K }>,
    fixes: readonly FixInput[],
    nowMs: number,
  ): ProcessorMutation;

  /**
   * Applies a replacement route or itinerary.
   *
   * The replacement is `unknown` because it arrived over the bridge; the
   * processor validates it against its own schema before returning a mutation,
   * so an invalid replacement never reaches the repository.
   */
  replace(
    session: Extract<MobileNavigationSession, { kind: K }>,
    replacement: unknown,
    nowMs: number,
  ): ProcessorMutation | { ok: false; code: string };

  repairTransitWalk?(
    session: Extract<MobileNavigationSession, { kind: K }>,
    legIndex: number,
    route: WalkRepairRoute,
    nowMs: number,
  ): ProcessorMutation | { ok: false; code: string };
  transitAction?(
    session: Extract<MobileNavigationSession, { kind: K }>,
    action: import("@openmapx/core/navigation").TransitRiderAction,
    nowMs: number,
  ): ProcessorMutation | { ok: false; code: string };
  /**
   * Applies the answer to an itinerary refresh, or returns null when the
   * session is no longer waiting on that request.
   */
  applyRefresh?(
    session: Extract<MobileNavigationSession, { kind: K }>,
    outcome: RefreshOutcome,
    nowMs: number,
  ): ProcessorMutation | null;
  /** A confirmed offline-to-online transition; may refresh or replan. */
  onConnectivityRestored(
    session: Extract<MobileNavigationSession, { kind: K }>,
    nowMs: number,
  ): Promise<ProcessorMutation | null>;
}

export type ProcessorKind = "ground" | "transit";

export type AnyNavigationProcessor = NavigationProcessor<"ground"> | NavigationProcessor<"transit">;

type SessionOf<K extends ProcessorKind> = Extract<MobileNavigationSession, { kind: K }>;

/**
 * Which modes this build can actually run.
 *
 * A capability is reported from what is registered, never from a constant: the
 * page acts on these, so claiming a mode with no processor behind it would
 * strand the user mid-journey.
 */
export class ProcessorRegistry {
  private readonly processors: { [K in ProcessorKind]?: NavigationProcessor<K> } = {};

  register(processor: AnyNavigationProcessor): void {
    if (processor.kind === "ground") this.processors.ground = processor;
    else this.processors.transit = processor;
  }

  /**
   * The processor for one mode. There is deliberately no signature for a kind
   * that could be either mode: its processor would accept either session.
   */
  get(kind: "ground"): NavigationProcessor<"ground"> | null;
  get(kind: "transit"): NavigationProcessor<"transit"> | null;
  get(kind: ProcessorKind): AnyNavigationProcessor | null {
    return this.processors[kind] ?? null;
  }

  supports(kind: ProcessorKind): boolean {
    return this.processors[kind] !== undefined;
  }

  /**
   * Runs `fn` with the processor for the session's mode and the session typed
   * for it, or returns null when this build has no processor for that mode.
   */
  withProcessor<R>(
    session: MobileNavigationSession,
    fn: <K extends ProcessorKind>(processor: NavigationProcessor<K>, session: SessionOf<K>) => R,
  ): R | null {
    if (session.kind === "ground") {
      const ground = this.processors.ground;
      return ground ? fn(ground, session) : null;
    }
    const transit = this.processors.transit;
    return transit ? fn(transit, session) : null;
  }
}
