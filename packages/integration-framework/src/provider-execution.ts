export interface ProviderCallContext {
  /** Request-scoped signal. Providers must pass it to cancellable I/O. */
  signal: AbortSignal;
  /** Absolute wall-clock deadline, for clients that accept a deadline rather than a signal. */
  deadlineAt: number;
}

export interface ProviderDeadlineOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export class ProviderTimeoutError extends Error {
  constructor() {
    super("provider deadline exceeded");
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderCancelledError extends Error {
  constructor() {
    super("provider call cancelled");
    this.name = "ProviderCancelledError";
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof ProviderTimeoutError
    ? signal.reason
    : new ProviderCancelledError();
}

/**
 * Abort provider work at a real deadline and also stop waiting if a provider
 * violates the signal contract. The abort is delivered before rejection.
 */
export async function runWithProviderDeadline<T>(
  call: (context: ProviderCallContext) => Promise<T>,
  options: ProviderDeadlineOptions,
): Promise<T> {
  const deadlineController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineController.signal])
    : deadlineController.signal;
  const deadlineAt = Date.now() + options.timeoutMs;
  const timer = setTimeout(
    () => deadlineController.abort(new ProviderTimeoutError()),
    options.timeoutMs,
  );

  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw abortError(signal);
        return call({ signal, deadlineAt });
      }),
      aborted,
    ]);
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    throw error;
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }
}

/** Promise.allSettled semantics with an explicit worker bound. */
export async function mapSettledWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  maxConcurrency: number,
  call: (input: TInput, index: number) => Promise<TOutput>,
): Promise<PromiseSettledResult<TOutput>[]> {
  const concurrency = Math.max(1, Math.floor(maxConcurrency));
  const results = new Array<PromiseSettledResult<TOutput>>(inputs.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await call(inputs[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  return results;
}
