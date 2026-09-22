import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { LiveWriterRequest, LiveWriterResponse } from "./live-writer-protocol.js";
import type { WriteLiveTrafficDeps, WriteLiveTrafficResult } from "./write-live.js";

/** One process-owned writer. No queue, retries, or timeout-based lock release. */
export function createLiveTrafficWriter(
  options: {
    workerUrl?: URL;
    shutdownTimeoutMs?: number;
    /** Terminal failure, delivered only after the thread has stopped. */
    onFailure?: (error: Error) => void;
  } = {},
) {
  let worker: Worker | undefined;
  let failed: Error | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let nextId = 0;
  let pending:
    | {
        id: number;
        resolve: (result: WriteLiveTrafficResult) => void;
        reject: (error: Error) => void;
        logger: WriteLiveTrafficDeps["logger"];
        settled: Promise<void>;
      }
    | undefined;
  const fail = (error: Error) => {
    failed ??= error;
    const current = pending;
    pending = undefined;
    current?.reject(error);
    worker?.unref();
  };
  const start = () => {
    if (worker) return worker;
    const entry =
      options.workerUrl ??
      new URL(
        import.meta.url.endsWith(".ts") ? "./live-writer-worker.ts" : "./live-writer-worker.js",
        import.meta.url,
      );
    worker = new Worker(entry, {
      execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href],
    });
    worker.on("error", fail);
    worker.on("exit", (code) => {
      const error = failed ?? new Error(`Live traffic writer exited (${code})`);
      fail(error);
      if (!closed) options.onFailure?.(error);
    });
    worker.on("message", (message: LiveWriterResponse) => {
      const current = pending;
      if (!current || current.id !== message.id) return;
      if (message.type === "warning") {
        try {
          current.logger?.warn(message.message, message.extra);
        } catch {
          /* Logging must not strand a write. */
        }
        return;
      }
      pending = undefined;
      worker?.unref();
      if (message.type === "result") current.resolve(message.result);
      else
        current.reject(
          Object.assign(new Error(message.error.message), {
            name: message.error.name,
            code: message.error.code,
          }),
        );
    });
    return worker;
  };
  return {
    write(deps: WriteLiveTrafficDeps): Promise<WriteLiveTrafficResult> {
      if (closed) return Promise.reject(new Error("Live traffic writer closed"));
      if (failed) return Promise.reject(failed);
      if (pending) return Promise.reject(new Error("Live traffic writer busy"));
      const { logger, ...payload } = deps;
      const id = ++nextId;
      let resolve!: (result: WriteLiveTrafficResult) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<WriteLiveTrafficResult>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      pending = {
        id,
        resolve,
        reject,
        logger,
        settled: result.then(
          () => undefined,
          () => undefined,
        ),
      };
      try {
        const owner = start();
        owner.ref();
        owner.postMessage({ id, deps: payload } satisfies LiveWriterRequest);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        fail(failure);
        if (worker) void worker.terminate();
        else if (!closed) options.onFailure?.(failure);
      }
      return result;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (pending)
            await Promise.race([
              pending.settled,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, options.shutdownTimeoutMs ?? 5_000);
              }),
            ]);
        } finally {
          if (timer) clearTimeout(timer);
          // Wait for actual thread exit. A partial write's lock/journal belongs
          // to independent supervisor recovery, never to this timeout.
          await worker?.terminate();
        }
      })();
      return closing;
    },
  };
}
