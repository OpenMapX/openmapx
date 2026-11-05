import type { FastifyInstance } from "fastify";
import type { ArtifactTransferStore } from "./store";

/** Observation and bounded cleanup only. Expiry cannot cancel a live execution. */
export function registerArtifactTransferLifecycle(
  app: FastifyInstance,
  store: ArtifactTransferStore,
): void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const sweep = (): Promise<void> => {
    if (running) return running;
    if (controller.signal.aborted) return Promise.resolve();
    running = store
      .reconcileTransferStages({ signal: controller.signal })
      .then((result) => {
        if (result.cleanupFailed) app.log.warn("Artifact stage cleanup requires recovery");
      })
      .catch(() => {
        if (!controller.signal.aborted) app.log.warn("Artifact stage cleanup is unavailable");
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  app.addHook("onReady", async () => {
    await sweep();
    timer = setInterval(() => {
      void sweep();
    }, 15 * 60000);
    timer.unref();
  });
  app.addHook("preClose", async () => {
    await store.drainByteStreams();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
    controller.abort();
    await running;
  });
}
