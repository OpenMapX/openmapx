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

function makeCtx(opts: {
  dataDir: string;
  composeFile?: string;
  runner: (command: string, args: string[]) => Promise<void>;
}) {
  return buildJobContext({
    dataDir: opts.dataDir,
    store: new StateStore(opts.dataDir),
    composeFile: opts.composeFile,
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
    const stagingDir = join(tmp, "motis-staging-data");
    mkdirSync(stagingDir, { recursive: true });

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
    const stagingDir = join(tmp, "motis-staging-data");
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
    // A single, clean import via the container entrypoint — no concurrent
    // `docker exec /motis import`.
    expect(calls).toEqual([{ command: "docker", args: ["restart", "motis-staging"] }]);
    expect(result.artifacts).toMatchObject({ action: "restarted", container: "motis-staging" });
    // The promote stage relies on this marker as its strong "import done"
    // signal — assert we drop it whenever the (re)start succeeds.
    const markerPath = join(stagingDir, ".data-manager-import.ok.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
    expect(marker).toMatchObject({ container: "motis-staging", action: "restarted" });
  });

  it("creates the container via compose up when it does not exist yet", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-import-create-"));
    const stagingDir = join(tmp, "motis-staging-data");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "x");

    const calls: Array<{ command: string; args: string[] }> = [];
    const ctx = makeCtx({
      dataDir: tmp,
      runner: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "restart") throw new Error("No such container: motis-staging");
      },
    });
    const result = await motisImportRun(ctx);
    expect(result.status).toBe("ok");
    expect(calls).toEqual([
      { command: "docker", args: ["restart", "motis-staging"] },
      { command: "docker", args: ["compose", "up", "-d", "motis-staging"] },
    ]);
    expect(result.artifacts).toMatchObject({ action: "created" });
  });

  it("passes -f <composeFile> to the create fallback when configured", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-import-compose-f-"));
    const stagingDir = join(tmp, "motis-staging-data");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "x");

    const composeFile = "/data/infra/docker/docker-compose.generated.yml";
    const calls: Array<{ command: string; args: string[] }> = [];
    const ctx = makeCtx({
      dataDir: tmp,
      composeFile,
      runner: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "restart") throw new Error("No such container: motis-staging");
      },
    });
    const result = await motisImportRun(ctx);
    expect(result.status).toBe("ok");
    // The fallback targets the explicit compose file rather than relying on the
    // process cwd having one — the prod data-manager's cwd has no compose.
    expect(calls).toEqual([
      { command: "docker", args: ["restart", "motis-staging"] },
      {
        command: "docker",
        args: ["compose", "-f", composeFile, "up", "-d", "motis-staging"],
      },
    ]);
  });

  it("returns error when neither restart nor compose up can start the container", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-import-startfail-"));
    const stagingDir = join(tmp, "motis-staging-data");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "x");

    const ctx = makeCtx({
      dataDir: tmp,
      runner: async (command) => {
        if (command === "docker") throw new Error("docker daemon unavailable");
      },
    });
    const result = await motisImportRun(ctx);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/failed to start motis-staging/);
  });
});
