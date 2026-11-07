import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  mintTransitousCapability,
  type TransitousRunnerScript,
} from "@openmapx/core/transitous-runner";
import { expect, it, vi } from "vitest";
import { createTransitousRunner, TransitousRunnerError } from "./runner";
import { buildTransitousRunnerServer } from "./server";

const KEY = Buffer.alloc(32, 3);
const NOW = 1_760_000_000_000;
const request = (run: TransitousRunnerScript = { script: "garbage-collect" }) => ({
  version: 1 as const,
  capability: mintTransitousCapability(KEY, { now: NOW, run }),
  run,
});

function ownedChildren() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-runner-shutdown-"));
  const groups: Array<{
    pid: number;
    alive: boolean;
    kills: number;
    probes: number;
    close: () => void;
  }> = [];
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    const group = groups.find((group) => group.pid === -pid);
    if (!group) throw Error(`Unexpected process group ${pid}`);
    if (signal === 0) {
      group.probes++;
      if (!group.alive) throw Object.assign(Error("Group exited"), { code: "ESRCH" });
    } else {
      expect(signal).toBe("SIGKILL");
      group.kills++;
      queueMicrotask(group.close);
    }
    return true;
  });
  mkdirSync(join(root, "catalog"));
  mkdirSync(join(root, "staging"));
  const spawnImpl = (() => {
    const child = new EventEmitter() as ChildProcess;
    let closed = false;
    const group = {
      pid: 424200 + groups.length,
      alive: true,
      kills: 0,
      probes: 0,
      close() {
        if (closed) return;
        closed = true;
        child.emit("close", 137);
      },
    };
    Object.assign(child, { pid: group.pid, stdout: new PassThrough(), stderr: new PassThrough() });
    groups.push(group);
    return child;
  }) as typeof spawn;
  return {
    groups,
    options: {
      catalogDir: join(root, "catalog"),
      stagingDir: join(root, "staging"),
      capabilityKey: KEY,
      now: () => NOW,
      spawnImpl,
    },
    release() {
      for (const group of groups) {
        group.alive = false;
        group.close();
      }
    },
    dispose() {
      kill.mockRestore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("closes admission and waits for every canceled descendant group", async () => {
  const children = ownedChildren();
  const runner = createTransitousRunner(children.options);
  const runs = [runner.run(request()), runner.run(request())];
  let stopped = false;
  try {
    const closing = runner.shutdown();
    void closing.then(() => {
      stopped = true;
    });
    expect(runner.shutdown()).toBe(closing);
    await vi.waitFor(() => expect(children.groups.every((group) => group.probes >= 2)).toBe(true));
    expect(stopped).toBe(false);
    expect(children.groups.map((group) => group.kills)).toEqual([1, 1]);
    const error = await runner.run(request()).catch((error: unknown) => error);
    expect(error).toEqual(Error("Runner is shutting down"));
    expect(error).not.toBeInstanceOf(TransitousRunnerError);
    expect(children.groups).toHaveLength(2);
    children.release();
    await closing;
    expect(await Promise.all(runs)).toMatchObject([
      { ok: false, exitCode: 1 },
      { ok: false, exitCode: 1 },
    ]);
  } finally {
    children.release();
    await Promise.allSettled(runs);
    children.dispose();
  }
});

it("settles shutdown after a retained execution rejected before spawning", async () => {
  const children = ownedChildren();
  const runner = createTransitousRunner(children.options);
  const invalid = request({ script: "fetch", feedPath: "feeds/missing.json" });
  try {
    await expect(runner.run(invalid)).rejects.toBeInstanceOf(TransitousRunnerError);
    expect(runner.inspect(invalid)).toMatchObject({
      state: "terminal",
      result: { ok: false, exitCode: 1 },
    });
    await runner.shutdown();
    expect(runner.inspect(invalid)).toMatchObject({
      state: "terminal",
      result: { ok: false, exitCode: 1 },
    });
    expect(children.groups).toHaveLength(0);
  } finally {
    children.dispose();
  }
});

it("closes an in-flight keep-alive response after containing the run", async () => {
  const children = ownedChildren();
  const app = buildTransitousRunnerServer(children.options);
  let reply: Promise<unknown> | undefined;
  let closing: Promise<unknown> | undefined;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    reply = fetch(`${address}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "keep-alive" },
      body: JSON.stringify(request()),
      signal: AbortSignal.timeout(5000),
    })
      .then(async (response) => ({
        status: response.status,
        connection: response.headers.get("connection"),
        body: await response.json(),
      }))
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(children.groups).toHaveLength(1));
    let stopped = false;
    closing = app.close().then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(children.groups.every((group) => group.probes >= 2)).toBe(true));
    expect(stopped).toBe(false);
    children.release();
    expect(await reply).toMatchObject({
      status: 200,
      connection: "close",
      body: { ok: false, exitCode: 1 },
    });
    await closing;
  } finally {
    children.release();
    // Drain only this fixture's sockets even when the old shutdown path hangs.
    app.server.closeAllConnections();
    await reply;
    await (closing ?? app.close());
    children.dispose();
  }
});

it("keeps ownership after a reader disconnects until explicit server shutdown", async () => {
  const children = ownedChildren();
  const app = buildTransitousRunnerServer(children.options);
  const controller = new AbortController();
  const ownedRequest = request();
  let disconnected = false;
  app.server.once("request", (incoming) => {
    incoming.socket.once("close", () => {
      disconnected = true;
    });
  });
  let reply: Promise<unknown> | undefined;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    reply = fetch(`${address}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ownedRequest),
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(children.groups).toHaveLength(1));
    controller.abort();
    await reply;
    await vi.waitFor(() => expect(disconnected).toBe(true));
    const status = await app.inject({
      method: "POST",
      url: "/v1/run/inspect",
      payload: ownedRequest,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: "running" });
    expect(children.groups.map((group) => group.kills)).toEqual([0]);
    const closing = app.close();
    await vi.waitFor(() => expect(children.groups.map((group) => group.kills)).toEqual([1]));
    children.release();
    await closing;
  } finally {
    controller.abort();
    children.release();
    app.server.closeAllConnections();
    await reply;
    await app.close();
    children.dispose();
  }
});
