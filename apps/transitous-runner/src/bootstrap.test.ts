import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTransitousCapability } from "@openmapx/core/transitous-runner";
import { expect, it, vi } from "vitest";

const KEY = "runner-fixture-capability-0123456789";
const loader = createRequire(import.meta.url).resolve("tsx/esm");

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function start(root: string, port: number) {
  const child = fork(new URL("./index.ts", import.meta.url), [], {
    execArgv: ["--import", loader],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      TRANSITOUS_RUNNER_PORT: String(port),
      TRANSITOUS_RUNNER_CATALOG_DIR: join(root, "catalog"),
      TRANSITOUS_RUNNER_STAGING_DIR: join(root, "staging"),
      TRANSITOUS_RUNNER_CAPABILITY_KEY_FILE: join(root, "key"),
    },
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, exit, output: () => output };
}

async function waitForExit(fixture: ReturnType<typeof start>) {
  await vi.waitFor(
    () => expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true),
    { timeout: 5000 },
  );
  return fixture.exit;
}

it.each(["SIGTERM", "SIGINT"] as const)(
  "real entrypoint contains its active group on %s",
  async (signal) => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-runner-signals-"));
    mkdirSync(join(root, "catalog/src"), { recursive: true });
    mkdirSync(join(root, "staging"));
    writeFileSync(join(root, "key"), KEY, { mode: 0o600 });
    writeFileSync(
      join(root, "catalog/src/garbage-collect.py"),
      [
        "import os, time",
        "from pathlib import Path",
        "marker = Path(os.environ['HOME'], 'owned-pid')",
        "temporary = marker.with_suffix('.partial')",
        "temporary.write_text(str(os.getpid()))",
        "temporary.rename(marker)",
        "while True: time.sleep(1)",
      ].join("\n"),
    );
    const port = await freePort();
    const fixtureProcess = start(root, port);
    let request: Promise<unknown> | undefined;
    let pid: number | undefined;
    try {
      await vi.waitFor(
        async () => {
          expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
        },
        { timeout: 5000, interval: 25 },
      );
      const run = { script: "garbage-collect" as const };
      request = fetch(`http://127.0.0.1:${port}/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "keep-alive" },
        body: JSON.stringify({
          version: 1,
          capability: mintTransitousCapability(Buffer.from(KEY), { now: Date.now(), run }),
          run,
        }),
        signal: AbortSignal.timeout(7000),
      })
        .then(async (response) => ({
          status: response.status,
          connection: response.headers.get("connection"),
          body: await response.json(),
        }))
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(existsSync(join(root, "staging/owned-pid"))).toBe(true), {
        timeout: 3000,
      });
      const ownedPid = Number(readFileSync(join(root, "staging/owned-pid"), "utf8"));
      expect(Number.isSafeInteger(ownedPid) && ownedPid > 1).toBe(true);
      pid = ownedPid;
      fixtureProcess.child.kill(signal);
      fixtureProcess.child.kill(signal === "SIGTERM" ? "SIGINT" : "SIGTERM");
      fixtureProcess.child.kill(signal);
      expect(await waitForExit(fixtureProcess), fixtureProcess.output()).toEqual({
        code: 0,
        signal: null,
      });
      expect(await request).toMatchObject({
        status: 200,
        connection: "close",
        body: { ok: false, exitCode: 1 },
      });
      expect(() => process.kill(-ownedPid, 0)).toThrow();
      expect(fixtureProcess.output()).toBe("");
    } finally {
      if (fixtureProcess.child.exitCode === null && fixtureProcess.child.signalCode === null)
        fixtureProcess.child.kill("SIGKILL");
      await fixtureProcess.exit;
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
      await request;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("reports a missing key without exposing its path and exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmapx-runner-startup-"));
  const fixtureProcess = start(root, 0);
  try {
    expect(await waitForExit(fixtureProcess)).toEqual({ code: 1, signal: null });
    expect(fixtureProcess.output()).toBe("transitous-runner failed to start\n");
  } finally {
    if (fixtureProcess.child.exitCode === null && fixtureProcess.child.signalCode === null)
      fixtureProcess.child.kill("SIGKILL");
    await fixtureProcess.exit;
    rmSync(root, { recursive: true, force: true });
  }
});

it("closes the failed listener and reports a generic startup failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmapx-runner-bind-failure-"));
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "0.0.0.0", resolve));
  const address = occupied.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  writeFileSync(join(root, "key"), KEY, { mode: 0o600 });
  const fixtureProcess = start(root, address.port);
  try {
    expect(await waitForExit(fixtureProcess)).toEqual({ code: 1, signal: null });
    expect(fixtureProcess.output()).toBe("transitous-runner failed to start\n");
  } finally {
    if (fixtureProcess.child.exitCode === null && fixtureProcess.child.signalCode === null)
      fixtureProcess.child.kill("SIGKILL");
    await fixtureProcess.exit;
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
