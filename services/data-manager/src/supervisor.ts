/** Independent process: a wedged or dead poller cannot prevent traffic expiry. */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverTrafficWriterLock } from "./jobs/traffic/supervision.js";
import { expireLiveTraffic } from "./jobs/traffic/write-live.js";
import { runOpsOperation } from "./ops-client.js";

const dataDir = process.env.DATA_DIR ?? "/data";
const statePath = join(dataDir, "traffic", "live-state.json");
const tarPath =
  process.env.TRAFFIC_TAR_PATH?.trim() || join(dataDir, "valhalla", "osm-pbf", "traffic.tar");
let worker: ChildProcess | undefined;
let stopping = false;
let fenced = false;
const stopWorker = async () => {
  const child = worker;
  if (!child) return;
  const exited =
    child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
  child.kill("SIGKILL");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Traffic worker did not exit after SIGKILL")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (worker === child) worker = undefined;
};
const shutdown = async () => {
  stopping = true;
  try {
    await stopWorker();
    if (existsSync(tarPath)) {
      await recoverTrafficWriterLock({ statePath, now: Number.MAX_SAFE_INTEGER, stopWorker });
      await expireLiveTraffic({ tarPath, statePath, now: Number.MAX_SAFE_INTEGER });
    }
  } catch {
    await runOpsOperation(
      { kind: "valhalla.traffic.disable" },
      { signal: AbortSignal.timeout(20_000) },
    ).catch(() => console.error("Traffic shutdown fence failed"));
  }
};
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

while (!stopping) {
  try {
    if (existsSync(join(dirname(tarPath), ".traffic-maintenance.json"))) {
      const workerPid = worker?.pid;
      await stopWorker();
      await recoverTrafficWriterLock({
        statePath,
        workerPid,
        now: Number.MAX_SAFE_INTEGER,
        stopWorker,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    await recoverTrafficWriterLock({ statePath, workerPid: worker?.pid, stopWorker });
    if (existsSync(tarPath)) await expireLiveTraffic({ tarPath, statePath });
    if (!worker && !fenced) {
      worker = spawn(
        process.execPath,
        ["--import", "tsx/esm", fileURLToPath(new URL("./index.js", import.meta.url))],
        { stdio: "inherit", env: process.env },
      );
      const child = worker;
      child.once("exit", () => {
        if (worker === child) worker = undefined;
      });
      child.once("error", () => {
        if (worker === child) worker = undefined;
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      fenced = true;
      await stopWorker().catch(() => undefined);
      // This dedicated operation has no caller-supplied container or argv.
      // Do not resume automatically: an operator must inspect/repair and restart.
      try {
        await runOpsOperation(
          { kind: "valhalla.traffic.disable" },
          { signal: AbortSignal.timeout(20_000) },
        );
      } catch {
        console.error(
          "Traffic safety fence failed; Valhalla serving requires operator intervention",
        );
      }
      console.error(
        "Traffic supervisor fenced the worker; repair journal/graph and restart explicitly",
      );
    }
  }
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5000));
}

await shutdown();
