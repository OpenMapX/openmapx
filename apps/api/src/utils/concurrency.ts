/**
 * A minimal async concurrency limiter. `limit(fn)` runs `fn` immediately when
 * fewer than `max` calls are in flight, otherwise queues it until a slot frees.
 *
 * Used to bound expensive request-level fan-out (e.g. place enrichment) so a
 * burst of *distinct* requests can't allocate N full pipelines at once and OOM
 * the process — the queued requests hold only their small closure + connection
 * while they wait, instead of N heavyweight pipelines running in parallel.
 */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`createLimiter: max must be a positive integer, got ${max}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const drain = () => {
    if (active >= max) return;
    const start = queue.shift();
    if (start) start();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        // Defer the user fn to a Promise so a synchronous throw still rejects.
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            drain();
          });
      };
      if (active < max) start();
      else queue.push(start);
    });
}
