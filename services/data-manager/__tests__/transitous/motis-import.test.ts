import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("invokes docker compose up + docker exec motis-staging /motis import -c <config>", async () => {
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
    expect(calls).toEqual([
      { command: "docker", args: ["compose", "up", "-d", "motis-staging"] },
      {
        command: "docker",
        args: ["exec", "motis-staging", "/motis", "import", "-c", "/motis-data/config.yml"],
      },
    ]);
    expect(result.artifacts).toMatchObject({
      configPath: "/motis-data/config.yml",
      container: "motis-staging",
    });
    expect(typeof (result.artifacts as { importDurationMs?: number }).importDurationMs).toBe(
      "number",
    );
  });

  it("returns error when docker compose up fails", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-import-startfail-"));
    const stagingDir = join(tmp, "motis-staging-data");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "x");

    const ctx = makeCtx({
      dataDir: tmp,
      runner: async (command) => {
        if (command === "docker") throw new Error("compose up failed");
      },
    });
    const result = await motisImportRun(ctx);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/failed to start motis-staging/);
  });

  it("returns error when the import itself fails", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-import-importfail-"));
    const stagingDir = join(tmp, "motis-staging-data");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "x");

    let upCalled = 0;
    const ctx = makeCtx({
      dataDir: tmp,
      runner: async (_command, args) => {
        if (args[0] === "compose") {
          upCalled++;
          return;
        }
        if (args[0] === "exec") throw new Error("import crashed: bad gtfs");
      },
    });
    const result = await motisImportRun(ctx);
    expect(upCalled).toBe(1);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/import crashed/);
  });

  it("respects MOTIS_IMPORT_TIMEOUT_MS by failing fast when the runner hangs", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-import-timeout-"));
    const stagingDir = join(tmp, "motis-staging-data");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "config.yml"), "x");

    const prev = process.env.MOTIS_IMPORT_TIMEOUT_MS;
    process.env.MOTIS_IMPORT_TIMEOUT_MS = "100";
    try {
      const ctx = makeCtx({
        dataDir: tmp,
        runner: async (_command, args) => {
          if (args[0] === "compose") return;
          if (args[0] === "exec") {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        },
      });
      const result = await motisImportRun(ctx);
      expect(result.status).toBe("error");
      expect(result.message).toMatch(/timed out after 100ms/);
    } finally {
      if (prev === undefined) delete process.env.MOTIS_IMPORT_TIMEOUT_MS;
      else process.env.MOTIS_IMPORT_TIMEOUT_MS = prev;
    }
  });
});
