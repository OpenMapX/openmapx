import { performance } from "node:perf_hooks";

export const STATUS_FRESH_MS = 30_000;
export const STATUS_STALE_MAX_MS = 5 * 60_000;

export type StatusRefreshErrorClass = "timeout" | "dependency-unavailable" | "unexpected";

export interface StatusRefreshFailureNotification {
  generation: number;
  errorClass: StatusRefreshErrorClass;
}

export interface StatusClockReading {
  /** Elapsed-process time. This must not move backwards with wall-clock adjustments. */
  monotonicMs: number;
  /** Calendar time used only for response timestamps. */
  wallTimeMs: number;
}

export type StatusSnapshotRead<T> =
  | {
      available: true;
      data: T;
      capturedAt: string;
      ageMs: number;
      stale: boolean;
      refreshErrorClass?: StatusRefreshErrorClass;
    }
  | {
      available: false;
      observedAt: string;
      stale: false;
      refreshErrorClass: StatusRefreshErrorClass;
    };

export interface StatusSnapshotStore<T> {
  read(): Promise<StatusSnapshotRead<T>>;
}

export interface StatusSnapshotStoreOptions<T> {
  probe: () => Promise<T>;
  now?: () => StatusClockReading;
  freshForMs?: number;
  staleForMs?: number;
  classifyError?: (error: unknown) => StatusRefreshErrorClass;
  onRefreshFailure?: (failure: StatusRefreshFailureNotification) => void;
}

interface SuccessfulSnapshot<T> {
  data: T;
  capturedAt: string;
  capturedMonotonicMs: number;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return undefined;
  const caused = (cause as { code?: unknown }).code;
  return typeof caused === "string" ? caused : undefined;
}

export function classifyStatusRefreshError(error: unknown): StatusRefreshErrorClass {
  if (error instanceof Error) {
    if (
      error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      /(?:time(?:d|s)? out|timeout)/i.test(error.message)
    ) {
      return "timeout";
    }
  }
  if (
    new Set(["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT"]).has(
      errorCode(error) ?? "",
    )
  ) {
    return "dependency-unavailable";
  }
  return "unexpected";
}

const defaultClock = (): StatusClockReading => ({
  monotonicMs: performance.now(),
  wallTimeMs: Date.now(),
});

/**
 * Keeps one successful status snapshot and one refresh promise per store.
 *
 * Production creates exactly one module-level store. Tests inject a monotonic
 * clock and probe so expiry, stale fallback and concurrency need no timers.
 */
export function createStatusSnapshotStore<T>(
  options: StatusSnapshotStoreOptions<T>,
): StatusSnapshotStore<T> {
  const now = options.now ?? defaultClock;
  const freshForMs = options.freshForMs ?? STATUS_FRESH_MS;
  const staleForMs = options.staleForMs ?? STATUS_STALE_MAX_MS;
  const classifyError = options.classifyError ?? classifyStatusRefreshError;

  let successful: SuccessfulSnapshot<T> | null = null;
  let inFlight: Promise<StatusSnapshotRead<T>> | null = null;
  let lastFailedAttemptMonotonicMs: number | null = null;
  let lastFailureClass: StatusRefreshErrorClass | null = null;
  let failureGeneration = 0;

  const snapshotAge = (reading: StatusClockReading): number | null =>
    successful === null ? null : Math.max(0, reading.monotonicMs - successful.capturedMonotonicMs);

  const staleOrUnavailable = (
    reading: StatusClockReading,
    refreshErrorClass: StatusRefreshErrorClass,
  ): StatusSnapshotRead<T> => {
    const ageMs = snapshotAge(reading);
    if (successful !== null && ageMs !== null && ageMs <= staleForMs) {
      return {
        available: true,
        data: successful.data,
        capturedAt: successful.capturedAt,
        ageMs,
        stale: true,
        refreshErrorClass,
      };
    }
    return {
      available: false,
      observedAt: new Date(reading.wallTimeMs).toISOString(),
      stale: false,
      refreshErrorClass,
    };
  };

  return {
    read(): Promise<StatusSnapshotRead<T>> {
      const reading = now();
      const ageMs = snapshotAge(reading);
      if (successful !== null && ageMs !== null && ageMs < freshForMs) {
        return Promise.resolve({
          available: true,
          data: successful.data,
          capturedAt: successful.capturedAt,
          ageMs,
          stale: false,
        });
      }

      if (inFlight !== null) return inFlight;

      if (
        lastFailedAttemptMonotonicMs !== null &&
        lastFailureClass !== null &&
        reading.monotonicMs - lastFailedAttemptMonotonicMs < freshForMs
      ) {
        return Promise.resolve(staleOrUnavailable(reading, lastFailureClass));
      }

      const refresh = Promise.resolve()
        .then(options.probe)
        .then((data): StatusSnapshotRead<T> => {
          const completed = now();
          successful = {
            data,
            capturedAt: new Date(completed.wallTimeMs).toISOString(),
            capturedMonotonicMs: completed.monotonicMs,
          };
          lastFailedAttemptMonotonicMs = null;
          lastFailureClass = null;
          return {
            available: true,
            data,
            capturedAt: successful.capturedAt,
            ageMs: 0,
            stale: false,
          };
        })
        .catch((error: unknown): StatusSnapshotRead<T> => {
          const completed = now();
          lastFailedAttemptMonotonicMs = completed.monotonicMs;
          lastFailureClass = classifyError(error);
          failureGeneration += 1;
          try {
            options.onRefreshFailure?.({
              generation: failureGeneration,
              errorClass: lastFailureClass,
            });
          } catch {
            // Observability must never turn a bounded status fallback into a 500.
          }
          return staleOrUnavailable(completed, lastFailureClass);
        })
        .finally(() => {
          if (inFlight === refresh) inFlight = null;
        });
      inFlight = refresh;
      return refresh;
    },
  };
}
