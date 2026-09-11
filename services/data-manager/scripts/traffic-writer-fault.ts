/** Disposable synthetic-engine fault injector. Never used by a service entrypoint. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [directory, mode] = process.argv.slice(2);
if (!directory || !["kill", "hang"].includes(mode ?? ""))
  throw new Error("Expected disposable probe directory and kill|hang");
const originalWrite = fs.writeSync;
fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
  const result = Reflect.apply(originalWrite, fs, args);
  // The writer fsyncs a durable pending journal before this first binary write.
  process.stdout.write("BINARY_WRITE\n");
  if (mode === "kill") process.kill(process.pid, "SIGKILL");
  else for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  return result;
}) as typeof fs.writeSync;
syncBuiltinESMExports();
const { writeLiveTraffic } = await import("../src/jobs/traffic/write-live.js");
const overrides = new Map(
  JSON.parse(await fs.promises.readFile(join(directory, "probe-overrides.json"), "utf8")),
);
await writeLiveTraffic({
  tarPath: join(directory, "traffic.tar"),
  statePath: join(directory, "probe-state.json"),
  csv: "way_id,dir,current_kph,free_flow_kph,los\n",
  waysToEdges: new Map(),
  overrides: overrides as Parameters<typeof writeLiveTraffic>[0]["overrides"],
});
