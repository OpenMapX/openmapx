vi.mock("../../src/jobs/transitous/owned-ops.js", async () => {
  const original = await vi.importActual<typeof import("../../src/jobs/transitous/owned-ops.js")>(
    "../../src/jobs/transitous/owned-ops.js",
  );
  return { ...original, ...(await import("../helpers/owned-transit-unit.js")) };
});

import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const snapshotRace = vi.hoisted(() => ({
  afterAccess: undefined as ((path: unknown, descriptor?: number) => void) | undefined,
  readFailure: undefined as Error | undefined,
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const stat = actual.lstatSync(...args);
      snapshotRace.afterAccess?.(args[0]);
      return stat;
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      snapshotRace.afterAccess?.(args[0], fd);
      return fd;
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (typeof args[0] === "number" && snapshotRace.readFailure) throw snapshotRace.readFailure;
      return actual.readFileSync(...args);
    },
  };
});

const opsCalls: { kind: string }[] = [];
const opsBehaviour: {
  failPromote: boolean;
  stopResult?: { changed: boolean; state?: string };
  stopFailure?: { kind: string; message: string };
  failRestart?: boolean;
} = { failPromote: false };
vi.mock("../../src/ops-client.js", () => ({
  runOpsOperation: vi.fn(async (operation: { kind: string }) => {
    opsCalls.push(operation);
    if (opsBehaviour.failPromote && operation.kind === "motis.primary.promote") {
      throw new Error("recreate failed");
    }
    if (opsBehaviour.stopFailure?.kind === operation.kind) {
      throw new Error(opsBehaviour.stopFailure.message);
    }
    if (opsBehaviour.failRestart && operation.kind === "motis.primary.restart") {
      throw new Error("old primary recovery failed");
    }
    if (operation.kind.endsWith(".stop")) {
      return opsBehaviour.stopResult ?? { changed: true, state: "stopped" };
    }
    return operation.kind === "motis.primary.promote"
      ? { activeRunId: "slot-a" }
      : { changed: true };
  }),
}));

import {
  CANDIDATE_MANIFEST_FILENAME,
  CANDIDATE_PROXY_DIRNAME,
  createCandidateManifest,
} from "../../src/jobs/transitous/candidate.js";
import { recordPromotedSource } from "../../src/jobs/transitous/feed-state-writer.js";
import { IMPORT_MARKER_FILE } from "../../src/jobs/transitous/internal.js";
import { probeHttp } from "../../src/jobs/transitous/motis-probe.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { run as promoteRun } from "../../src/jobs/transitous/promote.js";
import { aliasSlot, ensureMotisSlotLayout } from "../../src/jobs/transitous/slot-state.js";
import { TRANSIT_SOURCE_MANIFEST_FILENAME } from "../../src/jobs/transitous/source-manifest.js";
import { runOpsOperation } from "../../src/ops-client.js";
import { StateStore } from "../../src/state.js";

vi.mock("../../src/jobs/transitous/feed-state-writer.js", () => ({
  recordPromotedSource: vi.fn(async () => {}),
}));

let tmp: string | undefined;
let originalFetch: typeof fetch;
const originalProbeGet = probeHttp.get;
const defaultOpsImplementation = vi.mocked(runOpsOperation).getMockImplementation();
if (!defaultOpsImplementation) throw new Error("MOTIS operation test seam is unavailable");

beforeEach(() => {
  originalFetch = globalThis.fetch;
  vi.mocked(runOpsOperation).mockImplementation(defaultOpsImplementation);
  // Probe HTTP goes through the mocked global fetch (prod uses node:http).
  probeHttp.get = (url) => fetch(url);
  vi.mocked(recordPromotedSource).mockClear();
  opsCalls.length = 0;
  opsBehaviour.failPromote = false;
  delete opsBehaviour.stopResult;
  delete opsBehaviour.stopFailure;
  delete opsBehaviour.failRestart;
});

afterEach(() => {
  snapshotRace.afterAccess = undefined;
  snapshotRace.readFailure = undefined;
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
    writeFileSync(
      join(stagingDir, TRANSIT_SOURCE_MANIFEST_FILENAME),
      `${JSON.stringify({
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        sources: [
          {
            sourceId: "catalog:de:demo",
            region: "de",
            name: "demo",
            format: "gtfs",
            origin: "catalog",
            license: {},
            transformations: ["transitous-cleaning"],
            artifact: {
              relativePath: "demo.gtfs.zip",
              sha256: "0".repeat(64),
              sizeBytes: 4,
              modifiedAt: "2026-05-01T00:00:00.000Z",
            },
          },
        ],
      })}\n`,
    );
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
        pins: { motis: "2.11.3", transitous: "test" },
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

function directorySnapshot(root: string): unknown[] {
  const entries: unknown[] = [];
  const visit = (path: string, relative: string): void => {
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
      const target = readlinkSync(path);
      const alias = lstatSync(path);
      if (!alias.isSymbolicLink()) throw new Error("Snapshot alias changed during capture");
      entries.push([relative, alias.ino, "alias", target]);
      return;
    }
    try {
      const stat = fstatSync(descriptor);
      if (stat.isDirectory()) {
        entries.push([relative, stat.ino, "directory"]);
        for (const name of readdirSync(path).sort()) visit(join(path, name), join(relative, name));
      } else if (stat.isFile()) {
        entries.push([relative, stat.ino, "file", readFileSync(descriptor, "utf8")]);
      } else throw new Error("Snapshot entry must be a directory, alias or regular file");
    } finally {
      closeSync(descriptor);
    }
  };
  visit(root, ".");
  return entries;
}

function readyFixture(layout: "rename" | "two-slot") {
  const fx = setupFixture({ staging: true, current: true });
  mkdirSync(fx.previousDir, { recursive: true });
  writeFileSync(join(fx.previousDir, "retained-timetable"), "older rollback data");
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request | URL).toString();
    return jsonResponse(successfulBody(url));
  }) as unknown as typeof fetch;
  const ctx = makeCtx({ dataDir: fx.dataDir, runner: async () => {} });
  if (layout === "two-slot") ctx.slotLayout = ensureMotisSlotLayout(fx.dataDir);
  return { fx, ctx };
}

describe("promotion directory snapshot", () => {
  it("closes a captured marker descriptor when reading fails", () => {
    tmp = mkdtempSync(join(tmpdir(), "promotion-snapshot-close-"));
    const marker = join(tmp, "marker");
    writeFileSync(marker, "original marker");
    let descriptor: number | undefined;
    snapshotRace.afterAccess = (path, opened) => {
      if (path === marker && opened !== undefined) descriptor = opened;
    };
    const failure = new Error("controlled marker read failure");
    snapshotRace.readFailure = failure;
    const root = tmp;
    expect(() => directorySnapshot(root)).toThrow(failure);
    expect(descriptor).toBeTypeOf("number");
    if (descriptor === undefined) throw new Error("Expected an opened marker descriptor");
    const capturedDescriptor = descriptor;
    expect(() => fstatSync(capturedDescriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });
  it("retains the original marker metadata and content when its pathname is replaced", () => {
    tmp = mkdtempSync(join(tmpdir(), "promotion-snapshot-race-"));
    const root = tmp;
    const marker = join(root, "marker");
    writeFileSync(marker, "original marker");
    const inode = statSync(marker).ino;
    snapshotRace.afterAccess = (path) => {
      if (path !== marker) return;
      snapshotRace.afterAccess = undefined;
      renameSync(marker, join(root, "captured"));
      writeFileSync(marker, "replacement marker");
    };
    expect(directorySnapshot(tmp)).toContainEqual(["marker", inode, "file", "original marker"]);
  });
});

describe("promote stage", () => {
  describe.each(["rename", "two-slot"] as const)("confirmed stops in %s layout", (layout) => {
    it("stops primary then staging before activating the candidate", async () => {
      const { ctx } = readyFixture(layout);
      const result = await promoteRun(ctx);
      expect(result.status).toBe("ok");
      expect(opsCalls.map(({ kind }) => kind)).toEqual([
        "motis.primary.stop",
        "motis.staging.stop",
        "motis.primary.promote",
      ]);
    });

    it.each([
      { changed: false, state: "absent" },
      { changed: false, state: "stopped" },
    ])("accepts a confirmed already $state container", async (stopResult) => {
      const { ctx } = readyFixture(layout);
      opsBehaviour.stopResult = stopResult;
      const result = await promoteRun(ctx);
      expect(result.status).toBe("ok");
      expect(opsCalls.map(({ kind }) => kind)).toEqual([
        "motis.primary.stop",
        "motis.staging.stop",
        "motis.primary.promote",
      ]);
    });

    it.each([
      { changed: true },
      { changed: true, state: "running" },
      { changed: false, state: "unknown" },
    ])("preserves all data when primary stop is unconfirmed: %j", async (stopResult) => {
      const { fx, ctx } = readyFixture(layout);
      const before = directorySnapshot(fx.dataDir);
      opsBehaviour.stopResult = stopResult;
      const result = await promoteRun(ctx);
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/primary.*stop.*confirm/i);
      expect(opsCalls.map(({ kind }) => kind)).toEqual(["motis.primary.stop"]);
      expect(directorySnapshot(fx.dataDir)).toEqual(before);
      expect(recordPromotedSource).not.toHaveBeenCalled();
    });

    it.each(["operation timed out", "permission denied", "Docker daemon unreachable"])(
      "preserves all data and never blindly restarts an uncertain primary: %s",
      async (message) => {
        const { fx, ctx } = readyFixture(layout);
        const before = directorySnapshot(fx.dataDir);
        opsBehaviour.stopFailure = { kind: "motis.primary.stop", message };
        const result = await promoteRun(ctx);
        expect(result.status).toBe("error");
        expect(result.message).toContain(message);
        expect(opsCalls.map(({ kind }) => kind)).toEqual(["motis.primary.stop"]);
        expect(directorySnapshot(fx.dataDir)).toEqual(before);
        expect(recordPromotedSource).not.toHaveBeenCalled();
      },
    );

    it("acknowledges restarting a primary stopped by this attempt when staging stop fails", async () => {
      const { fx, ctx } = readyFixture(layout);
      const before = directorySnapshot(fx.dataDir);
      opsBehaviour.stopFailure = { kind: "motis.staging.stop", message: "staging stop timed out" };
      const result = await promoteRun(ctx);
      expect(result.status).toBe("error");
      expect(result.message).toContain("staging stop timed out");
      expect(result.message).toContain("old primary restart acknowledged on unchanged live data");
      expect(opsCalls.map(({ kind }) => kind)).toEqual([
        "motis.primary.stop",
        "motis.staging.stop",
        "motis.primary.restart",
      ]);
      expect(directorySnapshot(fx.dataDir)).toEqual(before);
      expect(recordPromotedSource).not.toHaveBeenCalled();
    });

    it.each(["absent", "stopped"])(
      "preserves an already %s primary on staging failure",
      async (state) => {
        const { fx, ctx } = readyFixture(layout);
        const before = directorySnapshot(fx.dataDir);
        opsBehaviour.stopResult = { changed: false, state };
        opsBehaviour.stopFailure = { kind: "motis.staging.stop", message: "staging stop failed" };
        const result = await promoteRun(ctx);
        expect(result.status).toBe("error");
        expect(result.message).toContain("staging stop failed");
        expect(opsCalls.map(({ kind }) => kind)).toEqual([
          "motis.primary.stop",
          "motis.staging.stop",
        ]);
        expect(directorySnapshot(fx.dataDir)).toEqual(before);
      },
    );

    it("does not start old-primary recovery after job cancellation", async () => {
      const { fx, ctx } = readyFixture(layout),
        before = directorySnapshot(fx.dataDir),
        controller = new AbortController();
      ctx.abortSignal = controller.signal;
      vi.mocked(runOpsOperation).mockImplementation(async (operation) => {
        opsCalls.push(operation);
        if (operation.kind === "motis.staging.stop") {
          controller.abort();
          throw Error("staging stop timed out");
        }
        return { changed: true, state: "stopped" };
      });
      await expect(promoteRun(ctx)).rejects.toThrow(/abort/i);
      expect(directorySnapshot(fx.dataDir)).toEqual(before);
      expect(opsCalls.map((call) => call.kind)).toEqual([
        "motis.primary.stop",
        "motis.staging.stop",
      ]);
      expect(recordPromotedSource).not.toHaveBeenCalled();
    });

    it("refuses promotion when the data target changes despite confirmed stops", async () => {
      const { fx, ctx } = readyFixture(layout);
      let externallyChanged: unknown[] = [];
      vi.mocked(runOpsOperation).mockImplementation(async (operation: { kind: string }) => {
        opsCalls.push(operation);
        if (operation.kind === "motis.staging.stop") {
          renameSync(ctx.motisDataDir, `${ctx.motisDataDir}.externally-moved`);
          mkdirSync(ctx.motisDataDir);
          writeFileSync(join(ctx.motisDataDir, "external-data"), "replacement");
          externallyChanged = directorySnapshot(fx.dataDir);
        }
        return { changed: true, state: "stopped" };
      });
      const result = await promoteRun(ctx);
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/identity changed/);
      expect(opsCalls.map(({ kind }) => kind)).toEqual([
        "motis.primary.stop",
        "motis.staging.stop",
      ]);
      expect(directorySnapshot(fx.dataDir)).toEqual(externallyChanged);
    });

    it("refuses recovery when the old live target changes during the staging stop", async () => {
      const { fx, ctx } = readyFixture(layout);
      let externallyChanged: unknown[] = [];
      vi.mocked(runOpsOperation).mockImplementation(async (operation: { kind: string }) => {
        opsCalls.push(operation);
        if (operation.kind === "motis.staging.stop") {
          renameSync(ctx.motisDataDir, `${ctx.motisDataDir}.externally-moved`);
          mkdirSync(ctx.motisDataDir);
          writeFileSync(join(ctx.motisDataDir, "external-data"), "replacement");
          externallyChanged = directorySnapshot(fx.dataDir);
          throw new Error("staging stop timed out");
        }
        return { changed: true, state: "stopped" };
      });
      const result = await promoteRun(ctx);
      expect(result.status).toBe("error");
      expect(result.message).toContain("staging stop timed out");
      expect(result.message).not.toContain(
        "old primary restart acknowledged on unchanged live data",
      );
      expect(result.message).toMatch(/identity changed.*recovery refused/);
      expect(opsCalls.map(({ kind }) => kind)).toEqual([
        "motis.primary.stop",
        "motis.staging.stop",
      ]);
      expect(directorySnapshot(fx.dataDir)).toEqual(externallyChanged);
    });

    it("reports both the stop failure and failed old-primary recovery", async () => {
      const { fx, ctx } = readyFixture(layout);
      const before = directorySnapshot(fx.dataDir);
      opsBehaviour.stopFailure = { kind: "motis.staging.stop", message: "staging stop timed out" };
      opsBehaviour.failRestart = true;
      const result = await promoteRun(ctx);
      expect(result.status).toBe("error");
      expect(result.message).toContain("staging stop timed out");
      expect(result.message).not.toContain(
        "old primary restart acknowledged on unchanged live data",
      );
      expect(result.message).toContain("old primary recovery failed");
      expect(opsCalls.map(({ kind }) => kind)).toEqual([
        "motis.primary.stop",
        "motis.staging.stop",
        "motis.primary.restart",
      ]);
      expect(directorySnapshot(fx.dataDir)).toEqual(before);
    });
  });

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
    expect(recordPromotedSource).not.toHaveBeenCalled();
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
    expect(recordPromotedSource).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "catalog:de:demo" }),
    );

    // After the swap: staging dir is empty (recreated), current has the new
    // sentinels, previous holds the old sentinel.
    expect(existsSync(fx.stagingDir)).toBe(true);
    expect(readdirSync(fx.stagingDir)).toEqual([]);
    expect(existsSync(join(fx.currentDir, "data", "tt.bin"))).toBe(true);
    expect(existsSync(fx.previousDir)).toBe(true);

    // The primary is stopped before the swap, then restarted against the
    // freshly-promoted data.
    // Stops and the post-swap recreate are typed agent operations now; the
    // ordering guarantee (stop before swap, promote after) is unchanged.
    expect(opsCalls.map((call) => call.kind)).toEqual([
      "motis.primary.stop",
      "motis.staging.stop",
      "motis.primary.promote",
    ]);
    expect(runnerCalls).toEqual([]);

    const artifacts = result.artifacts as { rollback?: boolean; previousDir?: string };
    expect(artifacts.rollback).toBe(false);
    expect(artifacts.previousDir).toBe(fx.previousDir);
  });

  it("preserves staging directory permissions for the next import", async () => {
    const fx = setupFixture({ staging: true, current: true });
    chmodSync(fx.stagingDir, 0o750);
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;

    const result = await promoteRun(
      makeCtx({
        dataDir: fx.dataDir,
        runner: async () => {},
      }),
    );

    expect(result.status).toBe("ok");
    expect(statSync(fx.stagingDir).mode & 0o777).toBe(0o750);
  });

  it("rejects a world-writable candidate before any host effect", async () => {
    const fx = setupFixture({ staging: true, current: true });
    chmodSync(fx.stagingDir, 0o777);
    const runner = vi.fn(async () => {});
    const result = await promoteRun(makeCtx({ dataDir: fx.dataDir, runner }));
    expect(result.status).toBe("error");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a candidate whose epoch duplicates the active dataset", async () => {
    const fx = setupFixture({ staging: true });
    cpSync(fx.stagingDir, fx.currentDir, { recursive: true });
    const result = await promoteRun(
      makeCtx({
        dataDir: fx.dataDir,
        runner: async () => {
          throw new Error("duplicate epoch must fail before container mutation");
        },
      }),
    );
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/duplicates the active dataset epoch/);
    expect(recordPromotedSource).not.toHaveBeenCalled();
  });

  it("bootstraps two-slot promotion without parsing pre-contract live metadata", async () => {
    const fx = setupFixture({ staging: true, current: true });
    writeFileSync(
      join(fx.currentDir, CANDIDATE_MANIFEST_FILENAME),
      `${JSON.stringify({
        schemaVersion: 1,
        epoch: "pre-slot-epoch",
        artifacts: {
          config: {},
          datasets: [],
          license: {},
          proxyConfig: {},
          proxyVars: {},
        },
      })}\n`,
    );
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;

    const ctx = makeCtx({ dataDir: fx.dataDir, runner: async () => {} });
    ctx.slotLayout = ensureMotisSlotLayout(fx.dataDir);
    expect(ctx.slotLayout.record.datasetEpoch).toBeUndefined();

    const result = await promoteRun(ctx);

    expect(result.status).toBe("ok");
    expect(ctx.slotLayout.record.datasetEpoch).toBe("test-epoch");
    expect(aliasSlot(ctx.slotLayout, "live")).toBe("B");
    expect(aliasSlot(ctx.slotLayout, "staging")).toBe("A");
  });

  it("rejects a duplicate epoch from authoritative two-slot state", async () => {
    const fx = setupFixture({ staging: true, current: true });
    writeFileSync(join(fx.currentDir, CANDIDATE_MANIFEST_FILENAME), "not current-contract json\n");
    const ctx = makeCtx({
      dataDir: fx.dataDir,
      runner: async () => {
        throw new Error("duplicate epoch must fail before container mutation");
      },
    });
    ctx.slotLayout = ensureMotisSlotLayout(fx.dataDir);
    ctx.slotLayout.record.datasetEpoch = "test-epoch";

    const result = await promoteRun(ctx);

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/duplicates the active dataset epoch/);
    expect(aliasSlot(ctx.slotLayout, "live")).toBe("A");
    expect(aliasSlot(ctx.slotLayout, "staging")).toBe("B");
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

    const runnerCalls: Array<{ command: string; args: string[] }> = [];
    const ctx = buildJobContext({
      dataDir: fx.dataDir,
      store: new StateStore(fx.dataDir),
      runner: async (command, args) => {
        runnerCalls.push({ command, args });
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });
    const result = await promoteRun(ctx);
    expect(result.status).toBe("ok");

    // The `--force-recreate --no-deps` scoping now lives in the agent (see
    // apps/ops-agent/src/docker-runtime.test.ts). What this asserts is that the
    // promote is requested as one typed operation and no docker argv is built
    // here at all.
    expect(opsCalls.map((call) => call.kind)).toContain("motis.primary.promote");
    expect(runnerCalls).toEqual([]);
  });

  it("rolls back the rename when docker restart fails", async () => {
    const fx = setupFixture({ staging: true, current: true });
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request | URL).toString();
      return jsonResponse(successfulBody(url));
    }) as unknown as typeof fetch;

    opsBehaviour.failPromote = true;
    opsCalls.length = 0;
    const ctx = makeCtx({ dataDir: fx.dataDir, runner: async () => undefined });
    const result = await promoteRun(ctx).finally(() => {
      opsBehaviour.failPromote = false;
    });
    expect(result.status).toBe("error");
    // The retained recovery phase restarts the original primary, never replays promotion.
    expect(opsCalls.filter((call) => call.kind === "motis.primary.promote")).toHaveLength(1);
    expect(opsCalls.filter((call) => call.kind === "motis.primary.restart")).toHaveLength(1);
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

    // Fail only the first activation so the rollback promote still succeeds.
    let promoteCalls = 0;
    const { runOpsOperation } = await import("../../src/ops-client.js");
    vi.mocked(runOpsOperation).mockImplementation(async (operation: { kind: string }) => {
      opsCalls.push(operation);
      if (operation.kind === "motis.primary.promote") {
        promoteCalls += 1;
        if (promoteCalls === 1) throw new Error("injected activation failure");
        return { activeRunId: "slot-a" };
      }
      return { changed: true, state: "stopped" };
    });
    const ctx = makeCtx({ dataDir: fx.dataDir, runner: async () => undefined });
    ctx.slotLayout = ensureMotisSlotLayout(fx.dataDir);
    expect(aliasSlot(ctx.slotLayout, "live")).toBe("A");
    expect(aliasSlot(ctx.slotLayout, "staging")).toBe("B");

    const result = await promoteRun(ctx);

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/slot B restart failed.*rollback ok/);
    expect(promoteCalls).toBe(1);
    expect(opsCalls.filter((call) => call.kind === "motis.primary.restart")).toHaveLength(1);
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
