import { type ControlInstallation, reconcileControlRetention } from "./control-authority";

/** Every participating role must collect independently, including idle roles.
 * Collection never grants admission: the existing origin/capacity checks do. */
export async function startControlRetentionMaintenance(
  installation: ControlInstallation,
  onError: (error: unknown) => void,
): Promise<() => Promise<void>> {
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  const collect = (maxFamilies = 64) => {
    if (controller.signal.aborted) return Promise.resolve();
    if (pending) return pending;
    pending = reconcileControlRetention(installation, {
      signal: controller.signal,
      maxFamilies,
    })
      .then(() => {})
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
  await collect(1);
  const timer = setInterval(() => {
    void collect();
  }, 5 * 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    controller.abort();
    await pending;
  };
}
