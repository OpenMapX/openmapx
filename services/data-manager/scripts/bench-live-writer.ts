/** Synthetic temporary files only; no DATA_DIR or operator traffic files. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { trafficFixture } from "../src/__tests__/live-writer-fixture.js";
import { createLiveTrafficWriter } from "../src/jobs/traffic/live-writer-client.js";
import { writeLiveTraffic } from "../src/jobs/traffic/write-live.js";

const dir = mkdtempSync(join(tmpdir(), "openmapx-writer-bench-"));
const owner = createLiveTrafficWriter();
try {
  const tiles = 10000;
  const edgesPerTile = 10;
  const fixture = trafficFixture(tiles, edgesPerTile);
  for (const mode of ["direct", "worker", "worker-warm"] as const) {
    const tarPath = join(dir, `${mode}.tar`);
    writeFileSync(tarPath, fixture);
    const waysToEdges = new Map(
      Array.from(
        { length: tiles },
        (_, tile) => [tile + 1, [{ forward: true, level: 2, tile, index: 1 }]] as const,
      ),
    );
    const csv =
      "way_id,dir,current_kph,free_flow_kph,los\n" +
      Array.from({ length: tiles }, (_, tile) => `${tile + 1},f,30,50,queuing`).join("\n");
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    await delay(30);
    const started = performance.now();
    const promise = (mode === "direct" ? writeLiveTraffic : owner.write)({
      tarPath,
      statePath: join(dir, `${mode}.json`),
      csv,
      waysToEdges,
    });
    const submissionMs = performance.now() - started;
    const result = await promise;
    const wallMs = performance.now() - started;
    await delay(30);
    histogram.disable();
    console.log(
      JSON.stringify({
        mode,
        tiles,
        edges: tiles * edgesPerTile,
        written: result.written,
        fixtureBytes: fixture.length,
        submissionMs,
        wallMs,
        delayP95Ms: histogram.percentile(95) / 1e6,
        delayMaxMs: histogram.max / 1e6,
        processPeakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  }
} finally {
  await owner.close();
  rmSync(dir, { recursive: true, force: true });
}
