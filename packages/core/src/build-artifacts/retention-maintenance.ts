import { type ControlInstallation, reconcileControlRetention } from "./control-authority";

/** Every participating role must collect independently, including idle roles.
 * Collection never grants admission: the existing origin/capacity checks do. */
export function startControlRetentionMaintenance(
  installation: ControlInstallation,
  onError: (error: unknown) => void,
): { ready: Promise<void>; stop: () => Promise<void> } {
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  let busyPasses = 0;
  const collect = (maxFamilies = 64) => {
    if (controller.signal.aborted) return Promise.resolve();
    if (pending) return pending;
    pending = reconcileControlRetention(installation, {
      signal: controller.signal,
      maxFamilies,
    })
      .then(({ busy }) => {
        if (!busy) busyPasses = 0;
        else if (++busyPasses === 2)
          throw Error("Control retention writer remains busy; supervised recovery required");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          try {
            onError(error);
          } catch {
            /* Diagnostics do not control admission. */
          }
        }
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  // Do not hold listener startup behind a whole backlog. The timer drains it.
  const ready = collect(1).then(() => controller.signal.throwIfAborted());
  const timer = setInterval(() => {
    void collect();
  }, 5 * 60_000);
  timer.unref();
  return {
    ready,
    stop: async () => {
      clearInterval(timer);
      controller.abort();
      await pending;
    },
  };
}
