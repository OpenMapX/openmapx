import { parentPort } from "node:worker_threads";
import type { LiveWriterRequest, LiveWriterResponse } from "./live-writer-protocol.js";
import { writeLiveTraffic } from "./write-live.js";

if (!parentPort) throw new Error("Live writer requires a worker thread");
const port = parentPort;
let busy = false;
const reply = (message: LiveWriterResponse) => port.postMessage(message);
port.on("message", async ({ id, deps }: LiveWriterRequest) => {
  if (busy) {
    reply({ id, type: "error", error: { name: "Error", message: "Live traffic writer busy" } });
    return;
  }
  busy = true;
  let warnings = 0;
  try {
    const result = await writeLiveTraffic({
      ...deps,
      logger: {
        warn(message, extra) {
          // A stale graph may reject millions of edges; bound messages and sizes.
          if (warnings++ >= 20) return;
          const bounded = Object.fromEntries(
            Object.entries(extra ?? {})
              .slice(0, 10)
              .map(([key, value]) => [
                key,
                typeof value === "number" || typeof value === "boolean"
                  ? value
                  : String(value).slice(0, 1024),
              ]),
          );
          reply({ id, type: "warning", message: message.slice(0, 1024), extra: bounded });
        },
      },
    });
    reply({ id, type: "result", result });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    reply({
      id,
      type: "error",
      error: {
        name: err.name ?? "Error",
        message: String(err.message ?? error).slice(0, 4096),
        code: err.code,
      },
    });
  } finally {
    busy = false;
  }
});
