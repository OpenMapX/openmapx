import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANDIDATE_PROXY_DIRNAME,
  createCandidateManifest,
} from "../../src/jobs/transitous/candidate.js";
import { IMPORT_MARKER_FILE } from "../../src/jobs/transitous/internal.js";
import { probeHttp } from "../../src/jobs/transitous/motis-probe.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { run as promoteRun } from "../../src/jobs/transitous/promote.js";
import { aliasSlot, ensureMotisSlotLayout } from "../../src/jobs/transitous/slot-state.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;
let originalFetch: typeof fetch;
const originalProbeGet = probeHttp.get;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Probe HTTP goes through the mocked global fetch (prod uses node:http).
  probeHttp.get = (url) => fetch(url);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  probeHttp.get = originalProbeGet;
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FixtureOptions {
  /**
   * Populate a "fully primed" staging dir: config.yml + the data-manager
   * import marker + the canonical MOTIS sentinel files. This is what a
   * successful pipeline run leaves behind.
   */
  staging?: boolean;
  /**
   * Variant for the sentinel-file fallback path: write config.yml and
   * sentinel files but skip the marker (simulates an operator who ran
   * MOTIS import out-of-band).
   */
  stagingWithoutMarker?: boolean;
  /**
   * Adversarial staging: directory exists, has some junk files, but no
   * config.yml. Used to assert the gate now fails closed instead of
   * passing on "directory non-empty" alone.
   */
  stagingJunk?: boolean;
  /** Create an existing live dir. */
  current?: boolean;
}

function setupFixture(opts: FixtureOptions): {
  dataDir: string;
  stagingDir: string;
  currentDir: string;
  previousDir: string;
} {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-promote-"));
  const stagingDir = join(tmp, "motis", "staging");
  const currentDir = join(tmp, "motis", "live");
  if (opts.staging) {
    mkdirSync(join(stagingDir, "data"), { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "server:\n  port: 8080\n");
    writeFileSync(join(stagingDir, "data", "tt.bin"), "tt");
    writeFileSync(
      join(stagingDir, IMPORT_MARKER_FILE),
      JSON.stringify({ finishedAt: "2026-05-01T00:00:00.000Z" }),
    );
  }
  if (opts.stagingWithoutMarker) {
    mkdirSync(join(stagingDir, "data"), { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "server:\n  port: 8080\n");
    writeFileSync(join(stagingDir, "data", "tt.bin"), "tt");
  }
  if (opts.stagingJunk) {
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "leftover.log"), "junk");
  }
  if (opts.current) {
    mkdirSync(join(currentDir, "data"), { recursive: true });
    writeFileSync(join(currentDir, "data", "tt.bin"), "tt-old");
  }
  if (opts.staging || opts.stagingWithoutMarker) {
    writeFileSync(
      join(stagingDir, "config.yml"),
      "timetable:\n  datasets:\n    demo:\n      path: demo.gtfs.zip\n",
    );
    writeFileSync(join(stagingDir, "demo.gtfs.zip"), "gtfs");
    writeFileSync(join(stagingDir, "license.json"), "{}\n");
    const proxy = join(stagingDir, CANDIDATE_PROXY_DIRNAME);
    mkdirSync(join(proxy, "conf"), { recursive: true });
    writeFileSync(join(proxy, "conf", "default.conf"), "server {}\n");
    writeFileSync(join(proxy, "feed-proxy-vars.json"), "{}\n");
    const manifest = createCandidateManifest(stagingDir, "test-epoch", "2026-05-01T00:00:00.000Z");
    writeFileSync(
      join(stagingDir, "mobility-capabilities.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        testedAt: "2026-05-01T00:00:00.000Z",
        epoch: manifest.epoch,
        pins: { motis: "2.10.2", transitous: "test" },
        artifacts: manifest.artifacts,
        expectations: manifest.expectations,
        health: { rt: true },
        probes: [],
      })}\n`,
    );
  }
  return {
    dataDir: tmp,
    stagingDir,
    currentDir,
    previousDir: `${currentDir}.previous`,
  };
}

function successfulBody(url: string): unknown {
  if (url.includes("/health")) return { rt: true };
  if (url.includes("/map/initial")) return { lat: 1, lon: 2, zoom: 3, serverConfig: {} };
  if (url.includes("/map/stops")) return [];
  return { itineraries: [{}], direct: [], requestParameters: {}, debugOutput: {} };
}

function makeCtx(opts: {
  dataDir: string;
  runner: (command: string, args: string[]) => Promise<void>;
}) {
  return buildJobContext({
    dataDir: opts.dataDir,
    store: new StateStore(opts.dataDir),
    runner: async (command, args) => {
      await opts.runner(command, args);
    },
    now: () => "2026-05-01T00:00:00.000Z",
  });
}

describe("promote stage", () => {
  it("skips when staging dir is missing", async () => {
    const fx = setupFixture({});
    const result = await promoteRun(
      makeCtx({
        dataDir: fx.dataDir,
        runner: async () => {
          throw new Error("docker should not be invoked");
        },
      }),
    );
    expect(result.status).toBe("skipped");
  });

  it("aborts and does not rename when smoke probes fail", async () => {
    const fx = setupFixture({ staging: true, current: true });
    globalThis.fetch = vi.fn(
      async () => new Response("no", { status: 500 }),
    ) as unknown as typeof fetch;
    const result = await promoteRun(
      makeCtx({
        dataDir: fx.dataDir,
        runner: async () => {
          throw new Error("docker should not be invoked");
        },
      }),
    );
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/staging probe "health" failed/);
    // Filesystem unchanged.
    expect(existsSync(fx.stagingDir)).toBe(true);
    expect(existsSync(fx.currentDir)).toBe(true);
    expect(existsSync(fx.previousDir)).toBe(false);
  });

  it("performs the atomic swap on smoke + restart success", async () => {
    const fx = setupFixture({ staging: true, current: true });

    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;

    const runnerCalls: Array<{ command: string; args: string[] }> = [];
    const ctx = makeCtx({
      dataDir: fx.dataDir,
      runner: async (command, args) => {
        runnerCalls.push({ command, args });
      },
    });
    const result = await promoteRun(ctx);
    expect(result.status).toBe("ok");

    // After the swap: staging dir is empty (recreated), current has the new
    // sentinels, previous holds the old sentinel.
    expect(existsSync(fx.stagingDir)).toBe(true);
    expect(readdirSync(fx.stagingDir)).toEqual([]);
    expect(existsSync(join(fx.currentDir, "data", "tt.bin"))).toBe(true);
    expect(existsSync(fx.previousDir)).toBe(true);

    // The primary is stopped before the swap, then restarted against the
    // freshly-promoted data.
    expect(runnerCalls).toEqual([
      { command: "docker", args: ["stop", "motis"] },
      { command: "docker", args: ["stop", "motis-staging"] },
      { command: "docker", args: ["restart", "motis"] },
    ]);

    const artifacts = result.artifacts as { rollback?: boolean; previousDir?: string };
    expect(artifacts.rollback).toBe(false);
    expect(artifacts.previousDir).toBe(fx.previousDir);
  });

  it("waits for the primary /health to load, not just /map/initial, before smoke-testing", async () => {
    // MOTIS binds its HTTP server (so /map/initial answers 200) BEFORE the
    // timetable finishes loading, during which /api/v1/health returns HTTP 400.
    // The post-swap readiness gate must poll the same /health endpoint the smoke
    // test then asserts on — otherwise it passes prematurely on /map/initial and
    // the terminal health probe fails 400, rolling back a perfectly good build.
    const fx = setupFixture({ staging: true, current: true });
    const previous = process.env.MOTIS_PROMOTE_RESTART_POLL_INTERVAL_MS;
    process.env.MOTIS_PROMOTE_RESTART_POLL_INTERVAL_MS = "5";
    try {
      // Staging (:8082) is already healthy from the motis-health stage; only the
      // freshly-restarted primary (:8081) is still loading its timetable.
      let primaryHealthCalls = 0;
      globalThis.fetch = vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : (input as Request | URL).toString();
        if (url.includes("/health") && url.includes(":8081")) {
          primaryHealthCalls += 1;
          // Still importing the timetable for the first couple of polls.
          if (primaryHealthCalls <= 2) return jsonResponse({ error: "loading" }, 400);
        }
        return jsonResponse(successfulBody(url));
      }) as unknown as typeof fetch;

      const ctx = makeCtx({ dataDir: fx.dataDir, runner: async () => {} });
      const result = await promoteRun(ctx);
      expect(result.status).toBe("ok");
      // The readiness poll kept going past the 400s (>=3 = two 400s + the 200
      // that opened the gate), proving it gated on /health rather than bailing
      // to the smoke test after a single premature /map/initial 200.
      expect(primaryHealthCalls).toBeGreaterThanOrEqual(3);
    } finally {
      if (previous === undefined) delete process.env.MOTIS_PROMOTE_RESTART_POLL_INTERVAL_MS;
      else process.env.MOTIS_PROMOTE_RESTART_POLL_INTERVAL_MS = previous;
    }
  });

  it("recreates only MOTIS with --no-deps when a compose file is present", async () => {
    const fx = setupFixture({ staging: true, current: true });
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;

    // A repoRoot with a compose file makes restartPrimary take the
    // `docker compose up` branch instead of the `docker restart` fallback.
    const repoRoot = mkdtempSync(join(tmpdir(), "openmapx-promote-repo-"));
    mkdirSync(join(repoRoot, "infra", "docker"), { recursive: true });
    writeFileSync(
      join(repoRoot, "infra", "docker", "docker-compose.generated.yml"),
      "services: {}\n",
    );

    const runnerCalls: Array<{ command: string; args: string[] }> = [];
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      repoRoot,
      store: new StateStore(fx.dataDir),
      runner: async (command, args) => {
        runnerCalls.push({ command, args });
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });
    const result = await promoteRun(ctx);
    expect(result.status).toBe("ok");

    const recreate = runnerCalls.find((call) => call.args.includes("up"));
    expect(recreate).toBeDefined();
    // Must scope the recreate to MOTIS only — otherwise compose recreates the
    // feed-proxy dependency and cascades into a second MOTIS recreate.
    expect(recreate?.args).toContain("--no-deps");
    expect(recreate?.args).toContain("--force-recreate");
    expect(recreate?.args.at(-1)).toBe("motis");

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("rolls back the rename when docker restart fails", async () => {
    const fx = setupFixture({ staging: true, current: true });
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;

    let restartCalls = 0;
    const ctx = makeCtx({
      dataDir: fx.dataDir,
      runner: async (_command, args) => {
        if (args[0] === "restart") {
          restartCalls++;
          throw new Error("docker daemon unavailable");
        }
      },
    });
    const result = await promoteRun(ctx);
    expect(result.status).toBe("error");
    expect(restartCalls).toBe(2); // initial + rollback restart
    // After successful rollback the previous data is back in `currentDir`,
    // and staging holds the (now-stale) new data.
    expect(existsSync(fx.currentDir)).toBe(true);
    expect(existsSync(fx.stagingDir)).toBe(true);
    expect(existsSync(fx.previousDir)).toBe(false);
    const artifacts = result.artifacts as { rollback?: boolean };
    expect(artifacts.rollback).toBe(true);
  });

  it("rolls A/B aliases back without committing slot state when activation restart fails", async () => {
    const fx = setupFixture({ staging: true, current: true });
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;

    let restartCalls = 0;
    const ctx = makeCtx({
      dataDir: fx.dataDir,
      runner: async (_command, args) => {
        if (args[0] !== "compose") return;
        restartCalls++;
        if (restartCalls === 1) throw new Error("injected activation failure");
      },
    });
    ctx.repoRoot = fx.dataDir;
    mkdirSync(join(ctx.repoRoot, "infra", "docker"), { recursive: true });
    writeFileSync(
      join(ctx.repoRoot, "infra", "docker", "docker-compose.generated.yml"),
      "services: {}\n",
    );
    ctx.slotLayout = ensureMotisSlotLayout(fx.dataDir);
    expect(aliasSlot(ctx.slotLayout, "live")).toBe("A");
    expect(aliasSlot(ctx.slotLayout, "staging")).toBe("B");

    const result = await promoteRun(ctx);

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/slot B restart failed.*rollback ok/);
    expect(restartCalls).toBe(2);
    expect(aliasSlot(ctx.slotLayout, "live")).toBe("A");
    expect(aliasSlot(ctx.slotLayout, "staging")).toBe("B");
    expect(ctx.slotLayout.record.activeSlot).toBe("A");
    const persisted = JSON.parse(readFileSync(ctx.slotLayout.statePath, "utf-8")) as {
      activeSlot: string;
      previousHealthySlot?: string;
    };
    expect(persisted).toEqual({ schemaVersion: 1, activeSlot: "A" });
  });

  it("works with no pre-existing current dir (first-ever promotion)", async () => {
    const fx = setupFixture({ staging: true });
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;

    const ctx = makeCtx({
      dataDir: fx.dataDir,
      runner: async () => {},
    });
    const result = await promoteRun(ctx);
    expect(result.status).toBe("ok");
    expect(existsSync(join(fx.currentDir, "data", "tt.bin"))).toBe(true);
    expect(existsSync(fx.previousDir)).toBe(false);
  });

  it("skips when staging has junk files but no config.yml or sentinels", async () => {
    const fx = setupFixture({ stagingJunk: true, current: true });
    const result = await promoteRun(
      makeCtx({
        dataDir: fx.dataDir,
        runner: async () => {
          throw new Error("docker should not be invoked");
        },
      }),
    );
    expect(result.status).toBe("skipped");
    // Filesystem unchanged — nothing renamed.
    expect(existsSync(fx.stagingDir)).toBe(true);
    expect(existsSync(fx.currentDir)).toBe(true);
    expect(existsSync(fx.previousDir)).toBe(false);
  });

  it("promotes via the MOTIS sentinel fallback when the marker file is absent", async () => {
    const fx = setupFixture({ stagingWithoutMarker: true, current: true });
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;
    const ctx = makeCtx({
      dataDir: fx.dataDir,
      runner: async () => {},
    });
    const result = await promoteRun(ctx);
    expect(result.status).toBe("ok");
    expect(existsSync(join(fx.currentDir, "data", "tt.bin"))).toBe(true);
  });
});
