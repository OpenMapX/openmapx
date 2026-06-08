import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as motisHealthRun } from "../../src/jobs/transitous/motis-health.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function makeStagingDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-health-"));
  const stagingDir = join(tmp, "motis", "staging");
  mkdirSync(stagingDir, { recursive: true });
  // Drop a single file so the readyness gate doesn't short-circuit.
  writeFileSync(join(stagingDir, "config.yml"), "server:\n  port: 8080\n");
  return tmp;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ctxFor(dataDir: string) {
  return buildJobContext({
    dataDir,
    store: new StateStore(dataDir),
    runner: async () => {},
    now: () => "2026-05-01T00:00:00.000Z",
  });
}

describe("motis-health stage", () => {
  it("skips when the staging data dir does not exist", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-health-skip-"));
    const result = await motisHealthRun(ctxFor(tmp));
    expect(result.status).toBe("skipped");
  });

  it("skips when the staging data dir is empty", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-health-empty-"));
    mkdirSync(join(tmp, "motis", "staging"), { recursive: true });
    const result = await motisHealthRun(ctxFor(tmp));
    expect(result.status).toBe("skipped");
  });

  it("returns ok after all probes succeed against the staging url", async () => {
    const dataDir = makeStagingDir();
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      calls.push(url);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const result = await motisHealthRun(ctxFor(dataDir));
    expect(result.status).toBe("ok");
    expect(calls.length).toBe(4);
    expect(calls[0]).toMatch(/\/api\/v1\/health$/);
    expect(calls[1]).toMatch(/\/api\/v1\/map\/initial$/);
    expect(calls[2]).toMatch(/\/api\/v1\/map\/stops\?/);
    expect(calls[3]).toMatch(/\/api\/v1\/plan\?/);
    expect((result.artifacts as { probes?: string[] }).probes).toEqual([
      "health",
      "initial",
      "stops",
      "plan",
    ]);
  });

  it("fails fast on the first probe failure and does not call later probes", async () => {
    const dataDir = makeStagingDir();
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      calls.push(url);
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;

    const result = await motisHealthRun(ctxFor(dataDir));
    expect(result.status).toBe("error");
    expect(calls.length).toBe(1);
    expect(result.message).toMatch(/probe "health" failed: HTTP 503/);
  });

  it("fails when a probe responds with a non-JSON content-type", async () => {
    const dataDir = makeStagingDir();
    globalThis.fetch = vi.fn(async () => {
      return new Response("<html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const result = await motisHealthRun(ctxFor(dataDir));
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/unexpected content-type text\/html/);
  });
});
