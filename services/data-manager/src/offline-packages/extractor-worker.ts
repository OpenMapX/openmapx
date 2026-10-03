import { parentPort, workerData } from "node:worker_threads";
import { extractPmtilesPackage } from "@openmapx/cli/tile-pmtiles";
import type { OfflinePackageExtractorOptions } from "./types.js";

if (!parentPort) throw new Error("Offline extraction requires a worker thread");
try {
  const result = await extractPmtilesPackage(workerData as OfflinePackageExtractorOptions);
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  parentPort.postMessage({
    type: "error",
    error: {
      name: err.name ?? "Error",
      message: String(err.message ?? error).slice(0, 4096),
      code: err.code,
    },
  });
} finally {
  parentPort.close();
}
