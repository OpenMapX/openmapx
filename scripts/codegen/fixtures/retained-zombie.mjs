import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [source, destination, marker] = process.argv.slice(2);
const realSpawn = childProcess.spawn;
const realSync = childProcess.execFileSync;
const realKill = process.kill;
const RealAggregateError = AggregateError;
const heartbeat = join(source, "writer");
const evidence = `${marker}.events`;
const describe = (error) =>
  error && {
    ...Object.fromEntries(
      ["name", "message", "code", "errno", "syscall", "stack"].map((key) => [key, error[key]]),
    ),
    ...(error.errors && { errors: error.errors.map(describe) }),
  };
const record = (event) => appendFileSync(evidence, `${JSON.stringify(event)}\n`);
const rows = () =>
  realSync("ps", ["-axo", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", timeout: 1_000 })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
const owner = () => JSON.parse(readFileSync(marker, "utf8"));
const ownedRows = () => {
  const pids = owner();
  return rows().filter((row) =>
    [process.pid, pids.supervisor, pids.writer, pids.wrapper].includes(Number(row[0])),
  );
};
let wrapper;
let triggered = false;
let killed = false;
mock.method(childProcess, "spawn", (command, args, options) => {
  const child = realSpawn(command, args, {
    ...options,
    env: {
      ...process.env,
      BIOME_BINARY: fileURLToPath(new URL("./retained-zombie.py", import.meta.url)),
      CODEGEN_ZOMBIE: JSON.stringify({ source, marker }),
    },
  });
  wrapper = child.pid;
  writeFileSync(`${marker}.group`, String(wrapper));
  return child;
});
mock.method(process, "kill", (pid, signal) => {
  try {
    const result = realKill(pid, signal);
    if (pid === -wrapper && signal === "SIGKILL" && !killed) {
      killed = true;
      const until = Date.now() + 500;
      let snapshot;
      do {
        snapshot = ownedRows();
        if (snapshot.some((row) => Number(row[0]) === owner().writer && row[3].startsWith("Z")))
          break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      } while (Date.now() < until);
      record({ event: "after-first-kill-before-wrapper-exit", snapshot });
    }
    record({ event: "kill", pid, signal, result });
    return result;
  } catch (error) {
    record({ event: "kill", pid, signal, error: describe(error), snapshot: ownedRows() });
    throw error;
  }
});
globalThis.AggregateError = new Proxy(RealAggregateError, {
  construct(target, args) {
    const error = Reflect.construct(target, args);
    record({ event: "aggregate", error: describe(error), snapshot: ownedRows() });
    return error;
  },
});
syncBuiltinESMExports();
const trigger = setInterval(() => {
  if (triggered || !existsSync(marker) || !existsSync(heartbeat)) return;
  const pids = owner();
  const snapshot = ownedRows();
  const writer = snapshot.find((row) => Number(row[0]) === pids.writer);
  if (!writer || Number(writer[2]) !== wrapper) return;
  assert.equal(Number(writer[1]), pids.supervisor);
  assert.equal(pids.group, wrapper);
  assert.ok(!writer[3].startsWith("Z"));
  assert.equal(
    Number(snapshot.find((row) => Number(row[0]) === pids.supervisor)[2]),
    pids.supervisor,
  );
  record({ event: "ready", owner: pids, snapshot });
  triggered = true;
  writeFileSync(`${marker}.go`, "go");
}, 5);
try {
  const { collectArtifacts } = await import(resolve("scripts/codegen/artifacts.mjs"));
  let failure;
  try {
    await collectArtifacts(source, destination, ["client.ts"]);
  } catch (error) {
    failure = error;
  }
  const snapshot = ownedRows();
  record({ event: "formatter-returned", error: describe(failure), snapshot });
  const pids = owner();
  assert.ok(snapshot.some((row) => Number(row[0]) === pids.writer && row[3].startsWith("Z")));
  assert.ok(!snapshot.some((row) => Number(row[2]) === wrapper && !row[3].startsWith("Z")));
  const before = readFileSync(heartbeat, "utf8");
  await delay(25);
  const after = readFileSync(heartbeat, "utf8");
  assert.equal(after, before);
  record({ event: "stable-before-scratch-cleanup", bytes: before.length, snapshot: ownedRows() });
  await rm(source, { recursive: true });
  record({ event: "scratch-removed" });
  assert.equal(failure?.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
} finally {
  clearInterval(trigger);
  globalThis.AggregateError = RealAggregateError;
  mock.restoreAll();
  syncBuiltinESMExports();
  writeFileSync(`${marker}.release`, "release");
  const until = Date.now() + 2_000;
  while (existsSync(marker) && Date.now() < until) {
    const remaining = ownedRows().filter((row) => Number(row[0]) !== process.pid);
    if (!remaining.length && existsSync(`${marker}.reaped`)) break;
    await delay(5);
  }
  if (existsSync(marker)) {
    record({
      event: "cleanup",
      reaped: JSON.parse(readFileSync(`${marker}.reaped`, "utf8")),
      snapshot: ownedRows(),
    });
    assert.equal(ownedRows().filter((row) => Number(row[0]) !== process.pid).length, 0);
  }
  console.log(`retained-zombie evidence: ${evidence}`);
}
