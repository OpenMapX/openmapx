import type {
  FixInput,
  MobileNavigationSession,
  NavigationStartPackage,
} from "@openmapx/core/navigation";
import type { ScheduledAlertInput, SessionEffect } from "../storage/SessionRepository";

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
  enqueue?: ReadonlyArray<{ eventId: string; critical: boolean; payload: unknown }>;
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
   * True for transit, where a schedule can advance a leg while the rider is
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

  /** A confirmed offline-to-online transition; may refresh or replan. */
  onConnectivityRestored(
    session: Extract<MobileNavigationSession, { kind: K }>,
    nowMs: number,
  ): Promise<ProcessorMutation | null>;
}

export type AnyNavigationProcessor = NavigationProcessor<"ground"> | NavigationProcessor<"transit">;

/**
 * Which modes this build can actually run.
 *
 * A capability is reported from what is registered, never from a constant: the
 * page acts on these, so claiming a mode with no processor behind it would
 * strand the user mid-journey.
 */
export class ProcessorRegistry {
  private readonly processors = new Map<string, AnyNavigationProcessor>();

  register(processor: AnyNavigationProcessor): void {
    this.processors.set(processor.kind, processor);
  }

  get(kind: "ground" | "transit"): AnyNavigationProcessor | null {
    return this.processors.get(kind) ?? null;
  }

  supports(kind: "ground" | "transit"): boolean {
    return this.processors.has(kind);
  }
}
