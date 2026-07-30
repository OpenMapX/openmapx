import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANDIDATE_PROXY_DIRNAME,
  createCandidateManifest,
} from "../../src/jobs/transitous/candidate.js";
import { run as motisHealthRun } from "../../src/jobs/transitous/motis-health.js";
import { probeHttp } from "../../src/jobs/transitous/motis-probe.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { TRANSIT_SOURCE_MANIFEST_FILENAME } from "../../src/jobs/transitous/source-manifest.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;
let originalFetch: typeof fetch;
let originalImportTimeout: string | undefined;
const originalProbeGet = probeHttp.get;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Probe HTTP goes through the mocked global fetch (prod uses node:http).
  probeHttp.get = (url) => fetch(url);
  originalImportTimeout = process.env.MOTIS_IMPORT_TIMEOUT_MS;
  // Bound the liveness poll so a never-healthy probe doesn't retry for the
  // 30-min default. Tests that need multiple poll iterations raise this.
  process.env.MOTIS_IMPORT_TIMEOUT_MS = "1000";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  probeHttp.get = originalProbeGet;
  if (originalImportTimeout === undefined) delete process.env.MOTIS_IMPORT_TIMEOUT_MS;
  else process.env.MOTIS_IMPORT_TIMEOUT_MS = originalImportTimeout;
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function makeStagingDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-health-"));
  const stagingDir = join(tmp, "motis", "staging");
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(
    join(stagingDir, "config.yml"),
    "timetable:\n  datasets:\n    demo:\n      path: demo.gtfs.zip\n",
  );
  writeFileSync(join(stagingDir, "demo.gtfs.zip"), "gtfs");
  writeFileSync(join(stagingDir, "license.json"), "{}\n");
  writeFileSync(
    join(stagingDir, TRANSIT_SOURCE_MANIFEST_FILENAME),
    '{"version":1,"generatedAt":"2026-05-01T00:00:00Z","sources":[]}\n',
  );
  const proxy = join(stagingDir, CANDIDATE_PROXY_DIRNAME);
  mkdirSync(join(proxy, "conf"), { recursive: true });
  writeFileSync(join(proxy, "conf", "default.conf"), "server {}\n");
  writeFileSync(join(proxy, "feed-proxy-vars.json"), "{}\n");
  createCandidateManifest(stagingDir, "test-epoch", "2026-05-01T00:00:00.000Z");
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

function successfulBody(url: string): unknown {
  if (url.includes("/health")) return { rt: true };
  if (url.includes("/map/initial")) return { lat: 1, lon: 2, zoom: 3, serverConfig: {} };
  if (url.includes("/map/stops")) return [];
  return { itineraries: [{}], direct: [], requestParameters: {}, debugOutput: {} };
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
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;

    const result = await motisHealthRun(ctxFor(dataDir));
    expect(result.status).toBe("ok");
    expect(calls.length).toBe(7);
    expect(calls[0]).toMatch(/\/api\/v1\/health$/);
    expect(calls[1]).toMatch(/\/api\/v1\/health$/);
    expect(calls[2]).toMatch(/\/api\/v1\/map\/initial$/);
    expect(calls[3]).toMatch(/\/api\/v1\/map\/stops\?/);
    expect(calls[4]).toMatch(/\/api\/v1\/plan\?/);
    expect(calls[5]).toMatch(/\/api\/v1\/plan\?/);
    expect(calls[6]).toMatch(/\/api\/v1\/plan\?/);
    expect(
      (result.artifacts as { probes?: Array<{ name: string }> }).probes?.map((p) => p.name),
    ).toEqual(["health", "initial", "stops", "plan", "plan-routed-transfers", "plan-elevation"]);
  });

  it("errors with the last failure when staging never becomes healthy", async () => {
    const dataDir = makeStagingDir();
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      calls.push(url);
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;

    const result = await motisHealthRun(ctxFor(dataDir));
    expect(result.status).toBe("error");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(result.message).toMatch(/probe "health" failed: HTTP 503/);
  });

  it("retries the liveness poll while staging is still importing (HTTP 400 → 200)", async () => {
    // MOTIS's /api/v1/health returns 400 until the timetable finishes importing,
    // then 200 — the poll must keep waiting, not bail on the first 400.
    process.env.MOTIS_IMPORT_TIMEOUT_MS = "6000";
    const dataDir = makeStagingDir();
    let n = 0;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      n += 1;
      // First health probe: not ready yet. Everything after: ready + JSON.
      if (n === 1) return new Response("not ready", { status: 400 });
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;

    const result = await motisHealthRun(ctxFor(dataDir));
    expect(result.status).toBe("ok");
    expect(n).toBeGreaterThanOrEqual(2); // retried past the initial 400
  }, 12_000);

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
