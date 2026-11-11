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
 * per second, while anything the user must not miss goes immediately.
 *
 * A throttled progress snapshot is dropped, never held or queued. Progress
 * snapshots are absolute: each carries every value a progress commit can
 * change, read from the committed session, and the page accepts any newer one.
 * The next one therefore says everything the dropped one would have, and a
 * position held for later would only show where the user used to be.
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

  constructor(private readonly ports: PublisherPorts) {}

  /**
   * Offers a snapshot for delivery.
   *
   * A full snapshot always goes: it is either the first thing the page sees or
   * the answer to something that invalidated what it had.
   */
  offer(snapshot: PublishableSnapshot, options: { immediate?: boolean } = {}): OfferOutcome {
    const now = this.ports.now();
    const urgent = snapshot.type === "full" || options.immediate === true;
    if (!urgent && now - this.lastProgressAtMs < PROGRESS_INTERVAL_MS) return "throttled";
    // Not queued when there is no page: after a reload the page gets a full
    // snapshot built from the committed session, which cannot be stale.
    if (!this.ports.deliver(snapshot)) return "dropped";
    this.lastProgressAtMs = now;
    return "sent";
  }
}
