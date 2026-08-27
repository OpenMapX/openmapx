interface Flight<T> {
  controller: AbortController;
  promise: Promise<T>;
  settled: boolean;
  waiters: number;
}

/**
 * Coalesces equal in-process work while bounding the number of tracked keys.
 * Callers can cancel independently; the shared operation is aborted only when
 * its last waiter leaves.
 */
export class BoundedSingleFlight {
  readonly #flights = new Map<string, Flight<unknown>>();

  constructor(private readonly maxFlights: number) {
    if (!Number.isSafeInteger(maxFlights) || maxFlights <= 0) {
      throw new Error("maxFlights must be a positive safe integer");
    }
  }

  run<T>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);

    let flight = this.#flights.get(key) as Flight<T> | undefined;
    if (!flight) {
      if (this.#flights.size >= this.maxFlights) {
        return operation(callerSignal ?? new AbortController().signal);
      }

      const controller = new AbortController();
      flight = {
        controller,
        promise: Promise.resolve().then(() => operation(controller.signal)),
        settled: false,
        waiters: 0,
      };
      this.#flights.set(key, flight as Flight<unknown>);
      void flight.promise.then(
        () => this.#finish(key, flight as Flight<unknown>),
        () => this.#finish(key, flight as Flight<unknown>),
      );
    }

    return this.#waitFor(key, flight, callerSignal);
  }

  #finish(key: string, flight: Flight<unknown>): void {
    flight.settled = true;
    if (this.#flights.get(key) === flight) this.#flights.delete(key);
  }

  #release(key: string, flight: Flight<unknown>): void {
    flight.waiters -= 1;
    if (flight.waiters === 0 && !flight.settled) {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
      flight.controller.abort(new Error("single-flight operation has no remaining callers"));
    }
  }

  #waitFor<T>(key: string, flight: Flight<T>, callerSignal?: AbortSignal): Promise<T> {
    flight.waiters += 1;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const settle = (callback: () => void) => {
        if (finished) return;
        finished = true;
        callerSignal?.removeEventListener("abort", onAbort);
        this.#release(key, flight as Flight<unknown>);
        callback();
      };
      const onAbort = () => settle(() => reject(callerSignal?.reason));

      callerSignal?.addEventListener("abort", onAbort, { once: true });
      void flight.promise.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    });
  }
}
