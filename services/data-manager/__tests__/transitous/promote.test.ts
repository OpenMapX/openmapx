import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_MARKER_FILE } from "../../src/jobs/transitous/internal.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { run as promoteRun } from "../../src/jobs/transitous/promote.js";
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
  const stagingDir = join(tmp, "motis-staging-data");
  const currentDir = join(tmp, "motis-data");
  if (opts.staging) {
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "server:\n  port: 8080\n");
    writeFileSync(join(stagingDir, "tt.json"), "{}");
    writeFileSync(join(stagingDir, "adr_extend.json"), "{}");
    writeFileSync(join(stagingDir, "osr_footpath.json"), "{}");
    writeFileSync(
      join(stagingDir, IMPORT_MARKER_FILE),
      JSON.stringify({ finishedAt: "2026-05-01T00:00:00.000Z" }),
    );
  }
  if (opts.stagingWithoutMarker) {
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "server:\n  port: 8080\n");
    writeFileSync(join(stagingDir, "tt.json"), "{}");
  }
  if (opts.stagingJunk) {
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "leftover.log"), "junk");
  }
  if (opts.current) {
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, "tt.json"), "{}-old");
  }
  return {
    dataDir: tmp,
    stagingDir,
    currentDir,
    previousDir: `${currentDir}.previous`,
  };
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

    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;

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
    expect(existsSync(join(fx.currentDir, "tt.json"))).toBe(true);
    expect(existsSync(fx.previousDir)).toBe(true);

    // The primary is stopped before the swap, then restarted against the
    // freshly-promoted data.
    expect(runnerCalls).toEqual([
      { command: "docker", args: ["stop", "motis"] },
      { command: "docker", args: ["restart", "motis"] },
    ]);

    const artifacts = result.artifacts as { rollback?: boolean; previousDir?: string };
    expect(artifacts.rollback).toBe(false);
    expect(artifacts.previousDir).toBe(fx.previousDir);
  });

  it("rolls back the rename when docker restart fails", async () => {
    const fx = setupFixture({ staging: true, current: true });
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;

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

  it("works with no pre-existing current dir (first-ever promotion)", async () => {
    const fx = setupFixture({ staging: true });
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;

    const ctx = makeCtx({
      dataDir: fx.dataDir,
      runner: async () => {},
    });
    const result = await promoteRun(ctx);
    expect(result.status).toBe("ok");
    expect(existsSync(join(fx.currentDir, "tt.json"))).toBe(true);
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
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    const ctx = makeCtx({
      dataDir: fx.dataDir,
      runner: async () => {},
    });
    const result = await promoteRun(ctx);
    expect(result.status).toBe("ok");
    expect(existsSync(join(fx.currentDir, "tt.json"))).toBe(true);
  });
});
