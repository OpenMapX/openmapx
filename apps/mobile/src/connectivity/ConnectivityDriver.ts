/**
 * Connectivity as an *input*, never as authority.
 *
 * Losing the network does not end a session and does not delete a captured
 * route — that is the whole point of capturing one. All this reports is whether
 * a request is worth attempting, and whether the page can be told it is offline.
 *
 * Reachability flaps constantly on a moving device: a tunnel, a lift, a cell
 * handover. A retry triggered by every flap would be worse than useless, so the
 * confirmed state used for network work is debounced while the state shown to
 * the user is not.
 */

export type ConnectivityState = "online" | "offline" | "unknown";

export interface ConnectivityDriver {
  /** Reports every change; the returned function unsubscribes. */
  subscribe(listener: (state: ConnectivityState) => void): () => void;
  current(): ConnectivityState;
}

/** How long a state must hold before it is treated as real for network retries. */
export const CONNECTIVITY_DEBOUNCE_MS = 3_000;

export interface DebouncedConnectivity {
  /** The state to show, updated immediately. */
  displayed: ConnectivityState;
  /** The state to act on, updated only after it has held. */
  confirmed: ConnectivityState;
}

/**
 * Splits an observed state into what the user sees and what the coordinator
 * acts on.
 *
 * Written as a fold over a timeline rather than a timer so the debounce is
 * testable without waiting: the caller supplies the clock.
 */
export function foldConnectivity(
  previous: DebouncedConnectivity & { changedAtMs: number },
  observed: ConnectivityState,
  nowMs: number,
): DebouncedConnectivity & { changedAtMs: number; confirmedTransition: boolean } {
  const changed = observed !== previous.displayed;
  const changedAtMs = changed ? nowMs : previous.changedAtMs;
  const heldLongEnough = nowMs - changedAtMs >= CONNECTIVITY_DEBOUNCE_MS;

  const confirmed =
    observed === previous.confirmed
      ? previous.confirmed
      : heldLongEnough
        ? observed
        : previous.confirmed;

  return {
    displayed: observed,
    confirmed,
    changedAtMs,
    // Only an offline-to-online transition is worth telling a processor about;
    // going offline needs no recovery work.
    confirmedTransition: previous.confirmed === "offline" && confirmed === "online",
  };
}

export function initialConnectivity(
  nowMs: number,
): DebouncedConnectivity & { changedAtMs: number } {
  return { displayed: "unknown", confirmed: "unknown", changedAtMs: nowMs };
}
