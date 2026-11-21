/// <reference lib="webworker" />
import { createWorkerCore, type WorkerRequest } from "./worker-core";

const core = createWorkerCore((...args) => fetch(...args));

/** Fetches, derives and encodes street detail and forest tiles off the main thread. */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  // Only the page that created this dedicated worker can post to it, and such
  // messages carry no origin; verify anyway, as the service worker does.
  if (event.origin && event.origin !== self.location.origin) return;
  void core.handle(event.data).then((result) => {
    if (result) (self as unknown as Worker).postMessage(result.response, result.transfer);
  });
};
