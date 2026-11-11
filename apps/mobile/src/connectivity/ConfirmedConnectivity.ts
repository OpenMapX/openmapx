import {
  CONNECTIVITY_DEBOUNCE_MS,
  type ConnectivityDriver,
  type ConnectivityState,
} from "./ConnectivityDriver";

/**
 * The connectivity navigation acts on: a state counts only once it has held for
 * `CONNECTIVITY_DEBOUNCE_MS`, so a tunnel, a lift or a cell handover that
 * flaps for a second does not offline a session or trigger a retry.
 *
 * The platform reports changes only, so a state that holds produces no second
 * event. A timer confirms it once the debounce has passed. Android pauses a
 * backgrounded app's timers, so `confirmed()` also re-checks against the clock,
 * which lets a location batch pick up a state the timer could not confirm.
 */
export class ConfirmedConnectivity {
  private observed: ConnectivityState;
  private changedAtMs: number;
  private confirmedState: ConnectivityState = "unknown";
  private cancelCheck: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly deps: {
      driver: ConnectivityDriver;
      now(): number;
      schedule(callback: () => void, delayMs: number): () => void;
    },
  ) {
    this.observed = deps.driver.current();
    this.changedAtMs = deps.now();
  }

  /** Follows the platform's reports; the returned function stops it. */
  start(): () => void {
    const unsubscribe = this.deps.driver.subscribe((state) => this.observe(state));
    this.scheduleCheck();
    return () => {
      unsubscribe();
      this.cancelCheck?.();
      this.cancelCheck = null;
    };
  }

  /** The newest state that has held long enough; `unknown` until one has. */
  confirmed(): ConnectivityState {
    this.check();
    return this.confirmedState;
  }

  /** Told after the confirmed state changes. */
  onConfirmed(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private observe(state: ConnectivityState): void {
    if (state === this.observed) return;
    this.observed = state;
    this.changedAtMs = this.deps.now();
    this.scheduleCheck();
  }

  private scheduleCheck(): void {
    this.cancelCheck?.();
    this.cancelCheck = this.deps.schedule(
      () => {
        this.cancelCheck = null;
        this.check();
      },
      Math.max(0, this.changedAtMs + CONNECTIVITY_DEBOUNCE_MS - this.deps.now()),
    );
  }

  private check(): void {
    if (this.observed === this.confirmedState) return;
    if (this.deps.now() - this.changedAtMs < CONNECTIVITY_DEBOUNCE_MS) return;
    this.confirmedState = this.observed;
    for (const listener of this.listeners) listener();
  }
}
