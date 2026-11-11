/**
 * Connectivity as an *input*, never as authority.
 *
 * Losing the network does not end a session and does not delete a captured
 * route — that is the whole point of capturing one. All this reports is whether
 * a request is worth attempting, and whether the page can be told it is offline.
 *
 * Reachability flaps constantly on a moving device: a tunnel, a lift, a cell
 * handover. A retry triggered by every flap would be worse than useless, so the
 * state navigation acts on is confirmed only once it has held
 * (`ConfirmedConnectivity`), while the state shown to the user is not.
 */

export type ConnectivityState = "online" | "offline" | "unknown";

export interface ConnectivityDriver {
  /** Reports every change; the returned function unsubscribes. */
  subscribe(listener: (state: ConnectivityState) => void): () => void;
  current(): ConnectivityState;
}

/** How long a state must hold before it is treated as real for network retries. */
export const CONNECTIVITY_DEBOUNCE_MS = 3_000;
