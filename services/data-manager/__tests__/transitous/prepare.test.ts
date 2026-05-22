import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { run as prepareRun } from "../../src/jobs/transitous/prepare.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("prepare stage", () => {
  it("clones the catalog on a clean data directory and returns an ok result", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-prepare-clone-"));
    const dataDir = join(tmp, "fresh-data");
    const catalogDir = join(dataDir, ".transitous-catalog");

    const calls: string[] = [];
    const runner = async (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args.includes("clone")) {
        mkdirSync(join(catalogDir, ".git"), { recursive: true });
        mkdirSync(join(catalogDir, "feeds"), { recursive: true });
      }
    };

    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      transitousRepoUrl: "/tmp/fake-transitous.git",
      runner,
      now: () => "2026-05-01T00:00:00.000Z",
    });

    const result = await prepareRun(ctx);

    expect(result.stage).toBe("prepare");
    expect(result.status).toBe("ok");
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(catalogDir)).toBe(true);
    expect(calls.some((c) => c.includes("clone"))).toBe(true);
    expect(ctx.state.catalogDir).toBe(catalogDir);
    expect(ctx.state.gtfsDir).toBe(join(dataDir, "gtfs"));
    expect(ctx.state.downloadsDir).toBe(join(dataDir, ".transitous-downloads"));
    expect(result.artifacts).toMatchObject({
      // No real git repo in the fixture; readGitHeadSha returns "" which the
      // stage maps to null. We just assert the key exists with the right shape.
      transitlandAtlasSha: null,
    });
    expect(result.artifacts && "ref" in result.artifacts).toBe(true);
  });

  it("refreshes the existing catalog with git pull + submodule update", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-prepare-existing-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });

    const calls: string[] = [];
    const runner = async (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(" ")}`);
    };

    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      runner,
      now: () => "2026-05-01T00:00:00.000Z",
    });

    const result = await prepareRun(ctx);

    expect(result.status).toBe("ok");
    expect(calls.some((c) => c.includes("reset --hard HEAD"))).toBe(true);
    expect(calls.some((c) => c.includes("pull --ff-only"))).toBe(true);
    expect(calls.some((c) => c.includes("submodule update --init --checkout --depth 1"))).toBe(
      true,
    );
  });

  it("warns and continues when no repoRoot is supplied (lockfile enforcement skipped)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-prepare-nolock-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });

    const warnings: string[] = [];
    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      runner: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
      logger: {
        info: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
      },
    });

    const result = await prepareRun(ctx);

    expect(result.status).toBe("ok");
    expect(warnings.some((w) => w.includes("no repoRoot supplied"))).toBe(true);
  });

  it("returns an error result when the catalog clone fails", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-prepare-clone-fail-"));
    const dataDir = join(tmp, "fresh-data");

    const runner = async (command: string, args: string[]) => {
      if (command === "git" && args.includes("clone")) {
        throw new Error("network down");
      }
    };

    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      transitousRepoUrl: "/tmp/fake-transitous.git",
      runner,
      now: () => "2026-05-01T00:00:00.000Z",
    });

    const result = await prepareRun(ctx);
    expect(result.status).toBe("error");
    expect(result.message).toContain("network down");
  });

  it("prunes orphaned GTFS dataset rows whose archives no longer exist on disk", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-prepare-orphan-"));
    const dataDir = tmp;
    const catalogDir = join(dataDir, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });

    const store = new StateStore(dataDir);
    const livePath = join(dataDir, "gtfs", "de_bvg.gtfs.zip");
    mkdirSync(join(dataDir, "gtfs"), { recursive: true });
    writeFileSync(livePath, "BVG");
    store.upsert({
      type: "gtfs",
      id: "de_bvg",
      sizeBytes: 3,
      downloadedAt: "2026-01-01T00:00:00.000Z",
      path: livePath,
    });
    store.upsert({
      type: "gtfs",
      id: "de_orphan",
      sizeBytes: 0,
      downloadedAt: "2026-01-01T00:00:00.000Z",
      path: join(dataDir, "gtfs", "de_orphan.gtfs.zip"),
    });

    const ctx = buildJobContext({
      dataDir,
      store,
      runner: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });

    const result = await prepareRun(ctx);
    expect(result.status).toBe("ok");

    const remaining = store.getAll().map((d) => d.id);
    expect(remaining).toEqual(["de_bvg"]);
  });
});
