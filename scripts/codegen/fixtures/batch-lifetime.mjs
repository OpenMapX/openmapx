#!/usr/bin/env node
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [source, destination, mode, marker] = process.argv.slice(2);

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Per-invocation fixture protocol, not a cached task input.
const nativeConfig = process.env.CODEGEN_LIFETIME_NATIVE;
if (nativeConfig) {
  const { source, mode, marker } = JSON.parse(nativeConfig);
  const write = () => appendFileSync(join(source, "writer"), "still running\n");
  write();
  writeFileSync(
    `${marker}.pending`,
    JSON.stringify({ native: process.pid, wrapper: process.ppid }),
  );
  renameSync(`${marker}.pending`, marker);
  // Keep the writer alive even if the pre-fix parent closes its output pipe.
  for (const stream of [process.stdout, process.stderr])
    stream.on("error", (error) => {
      if (error.code !== "EPIPE") throw error;
    });
  setInterval(write, 5);
  if (mode === "stdout" || mode === "stderr")
    process[mode].write(Buffer.alloc(16 * 1024 * 1024 + 1, "x"));
} else {
  const realSpawn = childProcess.spawn;
  const realSync = childProcess.execFileSync;
  const realTimer = globalThis.setTimeout;
  const env = {
    ...process.env,
    BIOME_BINARY: fileURLToPath(import.meta.url),
    CODEGEN_LIFETIME_NATIVE: JSON.stringify({ source, mode, marker }),
  };
  let wrapper;
  let deadline;
  let triggered = false;
  // Preserve the production deadline value; fire it only after native readiness.
  mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    if (milliseconds === 90_000) {
      deadline = () => callback(...args);
      return realTimer(() => assert.fail("readiness watchdog expired"), 5_000);
    }
    return realTimer(callback, milliseconds, ...args);
  });
  mock.method(childProcess, "spawn", (command, args, options) => {
    const child = realSpawn(command, args, { ...options, env });
    wrapper = child.pid;
    writeFileSync(`${marker}.group`, String(wrapper));
    return child;
  });
  // The pre-fix synchronous invocation cannot use the readiness timer. Its
  // shortened real timeout supplies RED; the PID marker independently proves
  // that the native writer was running before that call returned.
  mock.method(childProcess, "execFileSync", (command, args, options) =>
    realSync(command, args, { ...options, env, timeout: 1_000 }),
  );
  syncBuiltinESMExports();

  const live = (pid) => {
    const state = realSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000,
    }).trim();
    return state !== "" && !state.startsWith("Z");
  };
  const isLive = (pid) => {
    try {
      return live(pid);
    } catch (error) {
      if (error.status === 1 && error.stdout?.trim() === "") return false;
      throw error;
    }
  };
  const kill = (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code === "EPERM") {
        const states = realSync("ps", ["-axo", "pid=,pgid=,stat="], {
          encoding: "utf8",
          timeout: 1_000,
        })
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/));
        if (
          states.every((row) => row.length === 3) &&
          !states.some(
            ([id, group, state]) =>
              (pid < 0 ? Number(group) === -pid : Number(id) === pid) && !state.startsWith("Z"),
          )
        )
          return;
      }
      if (error.code !== "ESRCH") throw error;
    }
  };
  const trigger = setInterval(() => {
    if (triggered || !existsSync(marker)) return;
    triggered = true;
    if (mode === "timeout") {
      assert.equal(typeof deadline, "function", "the production deadline must be installed");
      deadline();
    }
    if (mode === "wrapper-exit") kill(wrapper);
  }, 5);
  try {
    const { collectArtifacts } = await import("../artifacts.mjs");
    let failure;
    const started = performance.now();
    try {
      await collectArtifacts(source, destination, ["client.ts"]);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "the failed formatter must reject");
    if (mode === "stdout" || mode === "stderr")
      if (failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") console.log(failure.stack);
    const pids = JSON.parse(readFileSync(marker, "utf8"));
    const observation = {
      mode,
      code: failure.code,
      message: failure.message,
      elapsedMs: Math.round(performance.now() - started),
      ...pids,
      nativeAliveBeforeCleanup: isLive(pids.native),
      wrapperAliveBeforeCleanup: isLive(pids.wrapper),
    };
    console.log(JSON.stringify(observation));
    assert.equal(observation.nativeAliveBeforeCleanup, false, "native writer survived rejection");
    assert.equal(observation.wrapperAliveBeforeCleanup, false, "wrapper survived rejection");
    if (mode === "timeout") assert.equal(failure.code, "ETIMEDOUT");
    if (mode === "stdout" || mode === "stderr")
      assert.equal(failure.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    await rm(source, { recursive: true });
    console.log("caller scratch cleanup completed after descendant termination");
  } finally {
    clearInterval(trigger);
    mock.restoreAll();
    if (wrapper) kill(-wrapper);
    if (existsSync(marker)) {
      const pids = JSON.parse(readFileSync(marker, "utf8"));
      kill(pids.native);
      const until = Date.now() + 2_000;
      while (isLive(pids.native) && Date.now() < until) await delay(5);
      assert.equal(isLive(pids.native), false, "fixture cleanup left a live native writer");
    }
    console.log("fixture process cleanup complete");
  }
}
