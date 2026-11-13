import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AnchoredDirectory, acquireGuardDirectory } from "./filesystem";
import { guard } from "./retention-family";

let root: string;
let holder: ChildProcess | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-family-guard-"));
});
afterEach(async () => {
  if (holder && holder.exitCode === null) {
    const exited = new Promise((resolve) => holder?.once("exit", resolve));
    holder.kill("SIGKILL");
    await exited;
  }
  holder = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** Another process takes the guard over and over, holding it a few
 * milliseconds each time, as a role inspecting maintenance does. It leaves
 * the guard free as long as it holds it: a shorter gap lets a loaded machine
 * starve the waiter for the whole wait, which no real holder does. */
function busyHolder(path: string, durationMs: number): ChildProcess {
  return spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
       const sleep = new Int32Array(new SharedArrayBuffer(4));
       const until = Date.now() + ${durationMs};
       while (Date.now() < until) {
         try { fs.mkdirSync(${JSON.stringify(path)}); } catch { continue; }
         Atomics.wait(sleep, 0, 0, 4);
         fs.rmdirSync(${JSON.stringify(path)});
         Atomics.wait(sleep, 0, 0, 4);
       }`,
    ],
    { stdio: "ignore" },
  );
}

it("waits for a live holder that keeps taking the guard instead of failing", async () => {
  const path = join(root, ".family-writer");
  holder = busyHolder(path, 6_000);
  const started = Date.now();
  while (!existsSync(path) && Date.now() - started < 5_000)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const dir = new AnchoredDirectory(root);
  try {
    let entered = 0;
    for (let attempt = 0; attempt < 100; attempt++)
      guard(dir, ".family-writer", () => {
        entered++;
      });
    expect(entered).toBe(100);
  } finally {
    dir.close();
  }
}, 30_000);

it("still refuses a guard nobody releases, once the wait is over", () => {
  mkdirSync(join(root, ".family-writer"));
  const dir = new AnchoredDirectory(root);
  const started = Date.now();
  try {
    expect(() => guard(dir, ".family-writer", () => undefined)).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
  } finally {
    dir.close();
  }
  const waited = Date.now() - started;
  expect(waited).toBeGreaterThanOrEqual(1_900);
  expect(waited).toBeLessThan(5_000);
});

// The lease journal guard takes its directory through the same wait.
it("lets a direct guard taker wait out the same busy holder", async () => {
  const path = join(root, ".journal-writer");
  holder = busyHolder(path, 6_000);
  const started = Date.now();
  while (!existsSync(path) && Date.now() - started < 5_000)
    await new Promise((resolve) => setTimeout(resolve, 5));
  for (let attempt = 0; attempt < 100; attempt++) {
    acquireGuardDirectory(path);
    rmdirSync(path);
  }
}, 30_000);
