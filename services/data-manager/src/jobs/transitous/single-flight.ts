/**
 * In-process latch for the Transitous sync worker. Durable admission already
 * allows one exclusive data execution at a time; this latch tells the worker
 * and the shutdown path whether a sync is running in this process.
 *
 * The data-manager runs as a single instance, so a process-local flag is
 * sufficient.
 */
export interface SingleFlightController {
  reserveOwned(jobId: string): boolean;
  markSyncFinished(jobId?: string): void;
  getInflight(): { jobId: string; startedAt: Date } | null;
}

/**
 * Build a controller. Exported as a factory (rather than a module-level
 * singleton) so tests can use isolated controllers. The production entrypoint
 * constructs one shared controller.
 */
export function createSingleFlightController(
  deps: { now?: () => number } = {},
): SingleFlightController {
  const now = deps.now ?? Date.now;
  let inflight: { jobId: string; startedAt: Date } | null = null;
  return {
    reserveOwned(jobId) {
      if (inflight) return false;
      inflight = { jobId, startedAt: new Date(now()) };
      return true;
    },
    markSyncFinished(jobId) {
      if (jobId !== undefined && inflight?.jobId !== jobId) return;
      inflight = null;
    },
    getInflight: () => (inflight ? { ...inflight } : null),
  };
}
