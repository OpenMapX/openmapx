import type { GroundSnapshot } from "./groundSnapshot";
import type { TransitSnapshot } from "./transitSnapshot";

/** Either mode’s projection; the publisher’s policy is identical for both. */
export type PublishableSnapshot = GroundSnapshot | TransitSnapshot;

/**
 * How often the page hears about progress.
 *
 * The engine produces a new position at up to 5 Hz; the page renders a puck
 * that a human is looking at. Five updates a second buys nothing visible and
 * costs a bridge round-trip each time, so ordinary progress is throttled to one
 * per second — while anything the user must not miss goes immediately.
 *
 * The other rule is that **stale progress is discarded, never queued**. If the
 * WebView is gone for ten seconds, delivering ten positions on reconnect would
 * animate the user backwards through where they used to be. Only the newest
 * survives, and after a reload the page gets a full snapshot built fresh from
 * storage rather than anything held in memory.
 */

export const PROGRESS_INTERVAL_MS = 1_000;

export interface PublisherPorts {
  /** Delivers a snapshot; returns false when there is no page to receive it. */
  deliver(snapshot: PublishableSnapshot): boolean;
  now(): number;
}

export type OfferOutcome = "sent" | "throttled" | "dropped";

export class SnapshotPublisher {
  private lastProgressAtMs = Number.NEGATIVE_INFINITY;
  private pending: PublishableSnapshot | null = null;

  constructor(private readonly ports: PublisherPorts) {}

  /**
   * Offers a snapshot for delivery.
   *
   * A full snapshot always goes: it is either the first thing the page sees or
   * the answer to something that invalidated what it had.
   */
  offer(snapshot: PublishableSnapshot, options: { immediate?: boolean } = {}): OfferOutcome {
    const now = this.ports.now();

    if (snapshot.type === "full" || options.immediate) {
      const delivered = this.ports.deliver(snapshot);
      if (delivered) {
        this.pending = null;
        this.lastProgressAtMs = now;
        return "sent";
      }
      // Even a full snapshot is not queued: after a reload the publisher builds
      // a new one from the authoritative session, which cannot be stale.
      return "dropped";
    }

    if (now - this.lastProgressAtMs < PROGRESS_INTERVAL_MS) {
      // Replace rather than append. The newest position is the only one worth
      // showing, and the older one describes somewhere the user has left.
      this.pending = snapshot;
      return "throttled";
    }

    if (!this.ports.deliver(snapshot)) {
      this.pending = null;
      return "dropped";
    }
    this.pending = null;
    this.lastProgressAtMs = now;
    return "sent";
  }

  /**
   * Delivers a throttled snapshot once its interval has elapsed.
   *
   * Called from the foreground tick. Returns whether anything went out, so a
   * caller can avoid scheduling itself again when there is nothing waiting.
   */
  flushPending(): boolean {
    if (!this.pending) return false;
    const now = this.ports.now();
    if (now - this.lastProgressAtMs < PROGRESS_INTERVAL_MS) return false;

    const snapshot = this.pending;
    this.pending = null;
    if (!this.ports.deliver(snapshot)) return false;
    this.lastProgressAtMs = now;
    return true;
  }

  /** Drops anything waiting, e.g. when the document that would receive it is gone. */
  discard(): void {
    this.pending = null;
  }

  /**
   * Forgets the throttle window.
   *
   * Called after a handshake so the first snapshot of a new document is not
   * held back by a timer belonging to the previous one.
   */
  reset(): void {
    this.pending = null;
    this.lastProgressAtMs = Number.NEGATIVE_INFINITY;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }
}
