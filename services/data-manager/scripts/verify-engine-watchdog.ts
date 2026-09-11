import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeLiveTraffic } from "../src/jobs/traffic/write-live.js";

const [baseUrl, directory] = process.argv.slice(2);
if (!baseUrl || !directory || !["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname))
  throw new Error("Supply disposable loopback watchdog probe");
const payload = {
  locations: [
    { lat: 52, lon: 12.996 },
    { lat: 52, lon: 13.024 },
  ],
  costing: "auto",
  date_time: { type: 0 },
  costing_options: { auto: { speed_types: ["freeflow", "constrained", "predicted", "current"] } },
};
async function length() {
  const response = await fetch(`${baseUrl}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error("Engine unavailable");
  return ((await response.json()) as { trip: { summary: { length: number } } }).trip.summary.length;
}
assert.ok((await length()) < 2, "Expected cleared synthetic baseline");
const overrides = new Map(
  JSON.parse(await readFile(join(directory, "probe-overrides.json"), "utf8")),
);
const deadline = Date.now() + 8000;
await writeLiveTraffic({
  tarPath: join(directory, "traffic.tar"),
  statePath: join(directory, "watchdog-state/live-state.json"),
  csv: "way_id,dir,current_kph,free_flow_kph,los\n",
  waysToEdges: new Map(),
  overrides: overrides as Parameters<typeof writeLiveTraffic>[0]["overrides"],
  validUntil: new Date(deadline).toISOString(),
});
let sawClosure = false;
while (Date.now() < deadline) {
  if ((await length()) > 3) {
    sawClosure = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(sawClosure, "Closure did not reach the running engine");
// No DM process or cleanup call runs after publication. The engine must fence itself.
let stopped = false;
while (Date.now() < deadline + 8000) {
  try {
    await length();
  } catch {
    stopped = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(stopped, "Engine continued serving after losing its writer lease");
console.log(
  JSON.stringify({ engineSelfFenced: true, delayAfterDeadlineMs: Date.now() - deadline }),
);
