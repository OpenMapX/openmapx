import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { edgeKey } from "../src/jobs/traffic/conditions-to-edges.js";
import { recoverTrafficWriterLock } from "../src/jobs/traffic/supervision.js";
import { decodeGraphId, type WayEdge } from "../src/jobs/traffic/ways-to-edges.js";
import { expireLiveTraffic, writeLiveTraffic } from "../src/jobs/traffic/write-live.js";

const [baseUrl, directory] = process.argv.slice(2);
if (!baseUrl || !directory || !["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname))
  throw new Error("Supply loopback probe URL and disposable synthetic graph directory");
const ways = new Map<number, WayEdge[]>();
for (const line of (await readFile(join(directory, "tiles/way_edges.txt"), "utf8"))
  .trim()
  .split("\n")) {
  const cells = line.split(",");
  const edges: WayEdge[] = [];
  for (let i = 1; i + 1 < cells.length; i += 2)
    edges.push({ forward: cells[i] === "1", ...decodeGraphId(BigInt(cells[i + 1]!)) });
  ways.set(Number(cells[0]), edges);
}
assert.deepEqual(
  [...ways.keys()].sort(),
  [10, 20, 30, 40],
  "Run only against the supplied synthetic graph",
);
const deps = {
  tarPath: join(directory, "traffic.tar"),
  statePath: join(directory, "probe-state.json"),
  csv: "way_id,dir,current_kph,free_flow_kph,los\n",
  waysToEdges: ways,
};
const route = async (
  costing = "auto",
  speedTypes = ["freeflow", "constrained", "predicted", "current"],
  dateTime?: { type: number; value?: string },
  reverse = false,
) => {
  const locations = [
    { lat: 52, lon: 12.996 },
    { lat: 52, lon: 13.024 },
  ];
  if (reverse) locations.reverse();
  const response = await fetch(`${baseUrl}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locations,
      costing,
      costing_options: { [costing]: { speed_types: speedTypes } },
      date_time: dateTime,
      units: "kilometers",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as {
    trip?: { summary: { length: number; time: number } };
    error?: string;
  };
  assert.ok(response.ok && body.trip, JSON.stringify(body));
  return body.trip!.summary;
};
const waitForRoute = async (accept: (route: { length: number; time: number }) => boolean) => {
  const deadline = Date.now() + 5000;
  while (true) {
    const result = await route("auto", undefined, { type: 0 });
    if (accept(result)) return result;
    assert.ok(
      Date.now() < deadline,
      "Existing engine mmap did not observe publication within five seconds",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
await writeLiveTraffic(deps);
const baseline = await waitForRoute((r) => r.length < 2);
const forward = ways.get(10)!.filter((e) => e.forward);
const overrides = new Map(
  forward.map((edge) => [
    edgeKey(edge),
    { closed: true as const, observationId: "synthetic-closure", edge },
  ]),
);
await writeLiveTraffic({
  ...deps,
  overrides,
  validUntil: new Date(Date.now() + 60_000).toISOString(),
});
await waitForRoute((r) => r.length > baseline.length + 0.5);
const results: Record<string, unknown> = { baseline };
for (const costing of ["auto", "pedestrian", "bicycle", "motorcycle"])
  results[costing] = await route(costing, undefined, { type: 0 });
results.withoutRoutingTime = await route();
results.noCurrent = await route("auto", ["freeflow", "constrained", "predicted"]);
results.departure = await route("auto", ["freeflow", "constrained", "predicted", "current"], {
  type: 1,
  value: "2026-09-12T12:00",
});
results.arrival = await route("auto", ["freeflow", "constrained", "predicted", "current"], {
  type: 2,
  value: "2026-09-12T12:00",
});
results.reverse = await route("auto", undefined, undefined, true);
assert.ok(
  (results.auto as typeof baseline).length > baseline.length + 0.5,
  "Current closure must detour driving",
);
assert.ok(
  Math.abs((results.reverse as typeof baseline).length - baseline.length) < 0.1,
  "Single-direction closure must not affect reverse routing",
);
assert.ok((results.motorcycle as typeof baseline).length > baseline.length + 0.5);
for (const key of ["pedestrian", "bicycle", "noCurrent", "withoutRoutingTime"])
  assert.ok(
    Math.abs((results[key] as typeof baseline).length - baseline.length) < 0.1,
    `${key} unexpectedly consumes closure records`,
  );
for (const key of ["departure", "arrival"])
  assert.ok(
    (results[key] as typeof baseline).length > baseline.length + 0.5,
    `${key} must be separated from today's shared records`,
  );
await expireLiveTraffic({
  tarPath: deps.tarPath,
  statePath: deps.statePath,
  now: Number.MAX_SAFE_INTEGER,
});
const cleared = await waitForRoute((r) => Math.abs(r.length - baseline.length) < 0.1);
assert.ok(
  Math.abs(cleared.length - baseline.length) < 0.1,
  "Expiry must restore baseline in the existing mmap",
);
results.cleared = cleared;
const cap = new Map(
  forward.map((edge) => [
    edgeKey(edge),
    { closed: false as const, capKph: 100, observationId: "synthetic-cap", edge },
  ]),
);
const capResult = await writeLiveTraffic({ ...deps, overrides: cap });
assert.equal(capResult.cappedEdges, 0, "Standalone cap without baseline must remain unapplied");
results.capWithoutBaseline = await route();
assert.ok(
  (results.capWithoutBaseline as typeof baseline).time >= baseline.time,
  "Standalone cap must not increase routing speed",
);
await expireLiveTraffic({
  tarPath: deps.tarPath,
  statePath: deps.statePath,
  now: Number.MAX_SAFE_INTEGER,
});
await writeLiveTraffic({
  ...deps,
  csv: "way_id,dir,current_kph,free_flow_kph,los\n10,f,20,30,free_flow\n",
});
const measured = await waitForRoute((r) => r.time > baseline.time + 15);
const measuredCap = new Map(
  forward.map((edge) => [
    edgeKey(edge),
    { closed: false as const, capKph: 10, observationId: "synthetic-cap", edge },
  ]),
);
const measuredResult = await writeLiveTraffic({
  ...deps,
  csv: "way_id,dir,current_kph,free_flow_kph,los\n10,f,20,30,free_flow\n",
  overrides: measuredCap,
});
assert.ok(measuredResult.cappedEdges > 0);
const capped = await waitForRoute((r) => r.time > measured.time + 15);
assert.ok(capped.time >= measured.time, "A cap must not increase effective speed");
results.measuredCap = { measured, capped };
await expireLiveTraffic({
  tarPath: deps.tarPath,
  statePath: deps.statePath,
  now: Number.MAX_SAFE_INTEGER,
});
await waitForRoute((r) => Math.abs(r.length - baseline.length) < 0.1);
await writeFile(join(directory, "probe-overrides.json"), JSON.stringify([...overrides]));
for (const mode of ["kill", "hang"]) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      fileURLToPath(new URL("./traffic-writer-fault.ts", import.meta.url)),
      directory,
      mode,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = once(child, "exit");
  const started = Date.now();
  await Promise.race([
    once(child.stdout!, "data"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Fault worker did not reach binary write")),
        10_000,
      ).unref(),
    ),
  ]);
  if (mode === "kill") await exited;
  const journal = JSON.parse(await readFile(`${deps.statePath}.journal.json`, "utf8"));
  assert.equal(journal.phase, "pending", "Crash must occur before publication commit");
  await recoverTrafficWriterLock({
    statePath: deps.statePath,
    now: Date.now() + 21_000,
    workerPid: child.pid,
    stopWorker: async () => {
      child.kill("SIGKILL");
      await exited;
    },
  });
  await expireLiveTraffic({ tarPath: deps.tarPath, statePath: deps.statePath });
  await waitForRoute((r) => Math.abs(r.length - baseline.length) < 0.1);
  results[`${mode}RecoveryMs`] = Date.now() - started;
}
await writeLiveTraffic({
  ...deps,
  overrides,
  validUntil: new Date(Date.now() + 2000).toISOString(),
});
await waitForRoute((r) => r.length > baseline.length + 0.5);
const leaseStarted = Date.now();
await new Promise((resolve) => setTimeout(resolve, 2100));
await expireLiveTraffic({ tarPath: deps.tarPath, statePath: deps.statePath });
await waitForRoute((r) => Math.abs(r.length - baseline.length) < 0.1);
results.shortLeaseRecoveryMs = Date.now() - leaseStarted;
await writeLiveTraffic({ ...deps, overrides });
await waitForRoute((r) => r.length > baseline.length + 0.5);
await writeFile(`${deps.statePath}.journal.json`, "{corrupt");
await expireLiveTraffic({ tarPath: deps.tarPath, statePath: deps.statePath });
await waitForRoute((r) => Math.abs(r.length - baseline.length) < 0.1);
results.corruptJournalCleared = true;
console.log(JSON.stringify(results, null, 2));
