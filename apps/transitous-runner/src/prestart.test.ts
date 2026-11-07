import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  mintTransitousCapability,
  type TransitousRunnerScript,
  transitousRunnerStatusSchema,
} from "@openmapx/core/transitous-runner";
import { afterEach, expect, it, vi } from "vitest";
import { createTransitousRunner, TransitousRunnerError } from "./runner";
import { buildTransitousRunnerServer } from "./server";

const KEY = Buffer.alloc(32, 3);
const NOW = 1_760_000_000_000;
const failureResult = {
  version: 1,
  ok: false,
  exitCode: 1,
  output: "",
  truncated: false,
  durationMs: 0,
};
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-runner-prestart-"));
  roots.push(root);
  const catalogDir = join(root, "catalog"),
    stagingDir = join(root, "staging");
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  mkdirSync(stagingDir);
  let now = NOW;
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(Error("Synthetic group has exited"), { code: "ESRCH" });
  });
  const spawned = vi.fn(() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 424200,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  return {
    root,
    spawned,
    options: {
      catalogDir,
      stagingDir,
      capabilityKey: KEY,
      now: () => now,
      spawnImpl: spawned as unknown as typeof spawn,
    },
    request(
      run: TransitousRunnerScript = { script: "fetch", feedPath: "feeds/missing.json" },
      key = KEY,
    ) {
      return { version: 1 as const, capability: mintTransitousCapability(key, { now, run }), run };
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("retains a process-free failure, permits acknowledgement and still forbids replay", async () => {
  const f = fixture(),
    runner = createTransitousRunner(f.options),
    request = f.request();
  await expect(runner.run(request)).rejects.toBeInstanceOf(TransitousRunnerError);
  expect(runner.inspect(request)).toEqual({ version: 1, state: "terminal", result: failureResult });
  expect(runner.acknowledge(request)).toEqual({ acknowledged: true });
  expect(() => runner.inspect(request)).toThrow("Original runner identity is unknown");
  await expect(runner.run(request)).rejects.toThrow("Capability has already been used");
  expect(f.spawned).not.toHaveBeenCalled();
});

it.each([
  { kind: "missing", status: 400, reason: "validation" },
  { kind: "escaping", status: 400, reason: "isolation" },
  { kind: "missing-catalog", status: 500, reason: "runtime" },
])(
  "preserves original HTTP status for $kind preparation and retains its exact outcome",
  async ({ kind, status, reason }) => {
    const f = fixture();
    if (kind === "escaping") {
      const outside = join(f.root, "outside.json");
      writeFileSync(outside, "{}");
      symlinkSync(outside, join(f.options.catalogDir, "feeds/missing.json"));
    }
    if (kind === "missing-catalog") rmSync(f.options.catalogDir, { recursive: true });
    const app = buildTransitousRunnerServer(f.options),
      request = f.request();
    const post = (url: string) => app.inject({ method: "POST", url, payload: request });
    try {
      const response = await post("/v1/run");
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ ok: false, error: reason });
      const inspected = await post("/v1/run/inspect");
      expect(inspected.statusCode).toBe(200);
      expect(transitousRunnerStatusSchema.parse(inspected.json())).toEqual({
        version: 1,
        state: "terminal",
        result: failureResult,
      });
      expect((await post("/v1/run/acknowledge")).json()).toEqual({ acknowledged: true });
      expect((await post("/v1/run")).statusCode).toBe(401);
      expect(f.spawned).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it("rejects unauthorized requests before they can probe catalog failures", async () => {
  const f = fixture();
  rmSync(f.options.catalogDir, { recursive: true });
  const app = buildTransitousRunnerServer(f.options);
  const request = f.request(undefined, Buffer.alloc(32, 7));
  try {
    const response = await app.inject({ method: "POST", url: "/v1/run", payload: request });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, error: "authorization" });
    expect(
      (await app.inject({ method: "POST", url: "/v1/run/inspect", payload: request })).statusCode,
    ).toBe(404);
    expect(f.spawned).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("keeps the capacity bound and leaves a refused capability usable after acknowledgement", async () => {
  const f = fixture(),
    runner = createTransitousRunner(f.options);
  const first = f.request();
  const requests = [first, ...Array.from({ length: 255 }, () => f.request())];
  for (const request of requests)
    await expect(runner.run(request)).rejects.toBeInstanceOf(TransitousRunnerError);
  const healthy = f.request({ script: "garbage-collect" });
  await expect(runner.run(healthy)).rejects.toThrow("Retained runner capacity is full");
  expect(() => runner.inspect(healthy)).toThrow("Original runner identity is unknown");
  expect(f.spawned).not.toHaveBeenCalled();
  expect(runner.acknowledge(first)).toEqual({ acknowledged: true });
  await expect(runner.run(healthy)).resolves.toMatchObject({ ok: true });
  expect(f.spawned).toHaveBeenCalledTimes(1);
});

it("expires failed preparation rows only after the existing 24-hour retention", async () => {
  const f = fixture(),
    runner = createTransitousRunner(f.options),
    failed = f.request();
  await expect(runner.run(failed)).rejects.toBeInstanceOf(TransitousRunnerError);
  f.advance(24 * 3600000);
  await runner.run(f.request({ script: "garbage-collect" }));
  expect(() => runner.inspect(failed)).not.toThrow();
  f.advance(1);
  await runner.run(f.request({ script: "garbage-collect" }));
  expect(() => runner.inspect(failed)).toThrow("Original runner identity is unknown");
});

it("does not turn an unclassified execution rejection into a contained result", async () => {
  const f = fixture(),
    runner = createTransitousRunner(f.options);
  const error = Error("Unclassified launch failure"),
    request = f.request({ script: "garbage-collect" });
  f.spawned.mockImplementationOnce(() => {
    throw error;
  });
  await expect(runner.run(request)).rejects.toBe(error);
  expect(runner.inspect(request)).toEqual({ version: 1, state: "running" });
  expect(() => runner.acknowledge(request)).toThrow("Runner remains active");
  await runner.shutdown();
  expect(runner.inspect(request)).toEqual({ version: 1, state: "cancel_pending" });
});
