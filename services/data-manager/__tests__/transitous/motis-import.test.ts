import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run as motisImportRun } from "../../src/jobs/transitous/motis-import.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

/** The dir the motis-staging container bind-mounts (plain bind, pipeline-owned). */
function stagingDirOf(dataDir: string): string {
  return join(dataDir, "motis", "staging");
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

describe("motis-import stage", () => {
  it("skips when the staging data dir is missing", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-import-missing-"));
    const ctx = makeCtx({
      dataDir: tmp,
      runner: async () => {
        throw new Error("runner should not be invoked when staging dir is missing");
      },
    });
    const result = await motisImportRun(ctx);
    expect(result.stage).toBe("motis-import");
    expect(result.status).toBe("skipped");
    expect(result.message).toMatch(/does not exist/);
  });

  it("skips when the staging config has not been generated", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-import-noconfig-"));
    mkdirSync(stagingDirOf(tmp), { recursive: true });

    const ctx = makeCtx({
      dataDir: tmp,
      runner: async () => {
        throw new Error("runner should not be invoked when config is missing");
      },
    });
    const result = await motisImportRun(ctx);
    expect(result.status).toBe("skipped");
    expect(result.message).toMatch(/config not generated/);
  });

  it("restarts the staging container to re-import and drops the marker", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-import-ok-"));
    const stagingDir = stagingDirOf(tmp);
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "server:\n  port: 8080\n");

    const calls: Array<{ command: string; args: string[] }> = [];
    const ctx = makeCtx({
      dataDir: tmp,
      runner: async (command, args) => {
        calls.push({ command, args });
      },
    });
    const result = await motisImportRun(ctx);
    expect(result.status).toBe("ok");
    // A single, clean import via the container entrypoint — `docker restart`
    // covers running / stopped / waiting-for-config, with no concurrent
    // `docker exec /motis import` and no `docker compose` (no plugin in the image).
    expect(calls).toEqual([{ command: "docker", args: ["restart", "motis-staging"] }]);
    expect(result.artifacts).toMatchObject({ action: "restarted", container: "motis-staging" });
    // The promote stage relies on this marker as its strong "import done"
    // signal — assert we drop it whenever the (re)start succeeds.
    const markerPath = join(stagingDir, ".data-manager-import.ok.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
    expect(marker).toMatchObject({ container: "motis-staging", action: "restarted" });
  });

  it("returns error when the staging container can't be (re)started", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-import-startfail-"));
    const stagingDir = stagingDirOf(tmp);
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "x");

    const ctx = makeCtx({
      dataDir: tmp,
      runner: async (command) => {
        if (command === "docker") throw new Error("No such container: motis-staging");
      },
    });
    const result = await motisImportRun(ctx);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/failed to \(re\)start motis-staging/);
  });
});
