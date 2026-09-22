import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createLiveTrafficWriter } from "../jobs/traffic/live-writer-client.js";
import { recoverTrafficWriterLock } from "../jobs/traffic/supervision.js";
import { trafficFixture } from "./live-writer-fixture.js";

it("keeps the parent responsive while a worker is stalled and awaits termination on close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-writer-stall-"));
  const marker = join(dir, "started");
  const entry = join(dir, "stall.mjs");
  writeFileSync(
    entry,
    `import { parentPort } from 'node:worker_threads'; import { writeFileSync } from 'node:fs';
    parentPort.on('message', () => { writeFileSync(${JSON.stringify(marker)}, 'started'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });`,
  );
  const writer = createLiveTrafficWriter({
    workerUrl: pathToFileURL(entry),
    shutdownTimeoutMs: 20,
  });
  const result = writer
    .write({
      tarPath: join(dir, "tar"),
      statePath: join(dir, "state"),
      csv: "",
      waysToEdges: new Map(),
    })
    .catch((error) => error);
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(5);
    expect(existsSync(marker)).toBe(true);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await delay(20);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    await writer.close();
    expect(await result).toBeInstanceOf(Error);
  } finally {
    await writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("shares the parent lock PID and cannot continue writing after that parent dies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-writer-parent-"));
  const tarPath = join(dir, "traffic.tar");
  const statePath = join(dir, "state.json");
  writeFileSync(tarPath, trafficFixture(1000, 1000));
  const clientUrl = new URL("../jobs/traffic/live-writer-client.ts", import.meta.url).href;
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      loader,
      "--input-type=module",
      "--eval",
      `import { createLiveTrafficWriter } from ${JSON.stringify(clientUrl)};
    const writer = createLiveTrafficWriter();
    await writer.write({ tarPath: ${JSON.stringify(tarPath)}, statePath: ${JSON.stringify(statePath)}, csv: '', waysToEdges: new Map() });
    await new Promise(() => {});`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  try {
    const ownerPath = join(`${statePath}.lock`, "owner.json");
    let owner: { pid: number } | undefined;
    const deadline = Date.now() + 10000;
    while (!owner && Date.now() < deadline) {
      try {
        owner = JSON.parse(readFileSync(ownerPath, "utf8"));
      } catch {
        await delay(2);
      }
    }
    expect(owner, stderr).toEqual(expect.objectContaining({ pid: child.pid }));
    child.kill("SIGKILL");
    await exited;
    const afterExit = readFileSync(tarPath);
    await delay(30);
    expect(readFileSync(tarPath).equals(afterExit)).toBe(true);
    await recoverTrafficWriterLock({
      statePath,
      workerPid: child.pid,
      now: Number.MAX_SAFE_INTEGER,
      stopWorker: async () => {
        await exited;
      },
    });
    expect(existsSync(`${statePath}.lock`)).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

it.skipIf(process.env.OPENMAPX_RUN_BUILT_WORKER_TESTS !== "1")(
  "runs the emitted JavaScript client and worker against a real tar",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "openmapx-writer-built-"));
    const tarPath = join(dir, "traffic.tar");
    writeFileSync(tarPath, trafficFixture());
    const clientUrl = new URL("../../dist/jobs/traffic/live-writer-client.js", import.meta.url)
      .href;
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        loader,
        "--input-type=module",
        "--eval",
        `import { createLiveTrafficWriter } from ${JSON.stringify(clientUrl)};
    const writer = createLiveTrafficWriter();
    try { console.log(JSON.stringify(await writer.write({ tarPath: ${JSON.stringify(tarPath)}, statePath: ${JSON.stringify(join(dir, "state.json"))},
      csv: 'way_id,dir,current_kph,free_flow_kph,los\\n1,f,30,50,queuing\\n', waysToEdges: new Map([[1, [{forward:true,level:2,tile:0,index:1}]]]) }))); }
    finally { await writer.close(); }`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    try {
      const [code] = await once(child, "exit");
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout).written).toBe(1);
      expect(Number(readFileSync(tarPath).readBigUInt64LE(1536 + 32 + 8) & 0x7fn)).toBe(15);
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
  10000,
);
