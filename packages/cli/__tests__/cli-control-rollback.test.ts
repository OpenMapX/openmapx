import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaseStoreDirectory, openLeaseStore } from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseProvenance } from "../../core/src/services/__fixtures__/release-provenance";
import { renderComposeForRepo } from "../src/commands/compose";
import { registerControlCommands } from "../src/commands/control";
import { dockerCompose, dockerComposeStream } from "../src/lib/docker";
import { applyGeneratedHardlinksBeforeStart } from "../src/lib/hardlinks";
import { assertDatabaseAllowsRollback, planRollback, type RollbackPlan } from "../src/lib/rollback";

vi.setConfig({ testTimeout: 60000 });

// The Docker and data-manager edges; generations, leases and the renderer are real.
vi.mock("../src/lib/docker", async (original) => ({
  ...(await original<typeof import("../src/lib/docker")>()),
  dockerCompose: vi.fn(),
  dockerComposeStream: vi.fn(),
  // A recreation that fails with an exit code reports a known outcome while the daemon answers.
  dockerDaemonReachable: vi.fn(async () => true),
}));
vi.mock("../src/lib/hardlinks", async (original) => ({
  ...(await original<typeof import("../src/lib/hardlinks")>()),
  applyGeneratedHardlinksBeforeStart: vi.fn(async () => undefined),
}));

const ids = ["alpha", "app-api", "data-manager", "ops-agent", "postgis"];
let root: string;
let infraDir: string;
let printed: string[];

function manifest(release: string, digit: string, when?: number): services.ReleaseManifest {
  return {
    schemaVersion: 1,
    release,
    images: Object.fromEntries(
      services.RELEASE_IMAGE_NAMES.map((name) => [
        name,
        `ghcr.io/openmapx/${name}@sha256:${digit.repeat(64)}`,
      ]),
    ) as services.ReleaseManifest["images"],
    ...releaseProvenance(),
    ...(when ? { databaseMigrationHead: { tag: `00${digit}0_release`, when } } : {}),
  };
}

function newestAppliedMigration(value: number | "fails") {
  vi.mocked(dockerCompose).mockResolvedValue(
    value === "fails"
      ? { exitCode: 1, stdout: "", stderr: "service postgis is not running" }
      : { exitCode: 0, stdout: `${value}\n`, stderr: "" },
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-rollback-"));
  infraDir = join(root, "infra/docker");
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(infraDir, { recursive: true });
  for (const id of ids) {
    const directory = join(root, "services", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "service.json"),
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        quality: "built-in",
        container: { image: `fixture/${id}`, tag: "1" },
      }),
    );
  }
  for (const [key, value] of Object.entries({
    OPENMAPX_ROOT_DIR: root,
    OPENMAPX_RELEASE: "local",
    DOMAIN: "example.test",
    OPENMAPX_ENABLED_SERVICES: "",
    POSTGRES_PASSWORD: "p".repeat(24),
    BETTER_AUTH_SECRET: "a".repeat(32),
  }))
    vi.stubEnv(key, value);
  printed = [];
  for (const stream of ["log", "error", "warn"] as const)
    vi.spyOn(console, stream).mockImplementation((line: string) => {
      printed.push(String(line));
    });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw Error(`exit:${code}`);
  });
  vi.mocked(dockerComposeStream).mockReset().mockResolvedValue(0);
  vi.mocked(dockerCompose).mockReset();
  vi.mocked(applyGeneratedHardlinksBeforeStart).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function render(selected: string[], release: services.ReleaseManifest | null) {
  services.writeServiceSelectionFile(infraDir, selected);
  return (await renderComposeForRepo({ rootDir: root, domain: "example.test", release }))
    .revisionId;
}
async function rollback(...args: string[]) {
  const program = new Command().exitOverride();
  registerControlCommands(program);
  return program.parseAsync(["node", "openmapx", "control", "rollback", ...args]);
}

describe("rollback plan", () => {
  it("targets the configuration applied with the previous release", async () => {
    expect(() => planRollback(infraDir)).toThrow(/No configuration/);
    const first = await render(["alpha"], manifest("release-1", "1", 100));
    expect(() => planRollback(infraDir)).toThrow(/No retained configuration pins another release/);
    const second = await render(["alpha", "app-api"], manifest("release-2", "2", 200));
    // A later render keeps release-2, so the target stays the first generation.
    const third = await render(["alpha", "app-api"], manifest("release-2", "2", 200));
    const plan = planRollback(infraDir);
    expect(plan).toMatchObject({ currentRevisionId: third, targetRevisionId: first });
    expect(second).not.toBe(third);
    expect(plan.current.manifest.release).toBe("release-2");
    expect(plan.target.manifest.release).toBe("release-1");
  });

  it("refuses when every retained configuration pins the applied release", async () => {
    await render(["alpha"], manifest("release-1", "1", 100));
    await render(["alpha", "app-api"], manifest("release-1", "1", 100));
    expect(() => planRollback(infraDir)).toThrow(/none is retained/);
  });

  it("skips a configuration left without pins by clearing the pin", async () => {
    const first = await render(["alpha"], manifest("release-1", "1", 100));
    await render(["alpha"], manifest("release-2", "2", 200));
    await render(["alpha"], null);
    expect(() => planRollback(infraDir)).toThrow(/applied configuration pins no release/);
    const current = await render(["alpha"], manifest("release-2", "2", 200));
    expect(planRollback(infraDir)).toMatchObject({
      currentRevisionId: current,
      targetRevisionId: first,
    });
  });
});

describe("the database check", () => {
  const plan = (
    target: services.ReleaseManifest,
    current: services.ReleaseManifest = manifest("release-2", "2", 200),
  ): RollbackPlan => ({
    currentRevisionId: `cfg1_${"b".repeat(43)}`,
    targetRevisionId: `cfg1_${"a".repeat(43)}`,
    current: { manifest: current, manifestDigest: services.releaseManifestDigest(current) },
    target: { manifest: target, manifestDigest: services.releaseManifestDigest(target) },
  });

  it("refuses when the database has a migration newer than the target release's newest", () => {
    expect(() => assertDatabaseAllowsRollback(plan(manifest("release-1", "1", 100)), 200)).toThrow(
      /newer than release release-1 \(its newest is 0010_release\)/,
    );
  });

  it("allows a database at or before the target release's newest migration", () => {
    expect(() =>
      assertDatabaseAllowsRollback(plan(manifest("release-1", "1", 100)), 100),
    ).not.toThrow();
    expect(() =>
      assertDatabaseAllowsRollback(plan(manifest("release-1", "1", 100)), 50),
    ).not.toThrow();
    expect(() =>
      assertDatabaseAllowsRollback(plan(manifest("release-1", "1", 100)), null),
    ).not.toThrow();
  });

  it("refuses a target that records no migration head", () => {
    expect(() => assertDatabaseAllowsRollback(plan(manifest("release-1", "1")), 1)).toThrow(
      /records no database migration head/,
    );
  });
});

describe("openmapx control rollback", () => {
  it("prints the plan and the configuration it reverts, and changes nothing without --yes", async () => {
    await render(["alpha"], manifest("release-1", "1", 100));
    const current = await render(["alpha", "app-api"], manifest("release-2", "2", 200));
    newestAppliedMigration(100);
    await expect(rollback()).rejects.toThrow("exit:0");
    const output = printed.join("\n");
    expect(output).toContain("(release release-2)");
    expect(output).toContain("(release release-1)");
    expect(output).toContain("reverts every configuration change made since");
    expect(output).toContain("Services it does not select keep running");
    expect(output).toContain("Run again with --yes");
    expect(services.currentConfigurationGeneration(infraDir)).toBe(current);
    expect(dockerComposeStream).not.toHaveBeenCalled();
  });

  it("refuses when the database is newer than the previous release and changes nothing", async () => {
    await render(["alpha"], manifest("release-1", "1", 100));
    const current = await render(["alpha"], manifest("release-2", "2", 200));
    newestAppliedMigration(200);
    await expect(rollback("--yes")).rejects.toThrow(/newer than release release-1/);
    expect(services.currentConfigurationGeneration(infraDir)).toBe(current);
    expect(dockerComposeStream).not.toHaveBeenCalled();
  });

  it("refuses when the database's migrations cannot be read", async () => {
    await render(["alpha"], manifest("release-1", "1", 100));
    await render(["alpha"], manifest("release-2", "2", 200));
    newestAppliedMigration("fails");
    await expect(rollback("--yes")).rejects.toThrow(/postgis must be running/);
    expect(dockerComposeStream).not.toHaveBeenCalled();
  });

  it("renders the previous configuration and release again and recreates in self-update order", async () => {
    const previous = await render(["alpha", "data-manager"], manifest("release-1", "1", 100));
    const current = await render(
      ["alpha", "app-api", "data-manager", "ops-agent", "postgis"],
      manifest("release-2", "2", 200),
    );
    newestAppliedMigration(90);
    await expect(rollback("--yes")).rejects.toThrow("exit:0");
    const applied = services.currentConfigurationGeneration(infraDir);
    expect(applied).not.toBe(current);
    assert.isNotNull(applied);
    // A second rollback goes forward again.
    expect(services.readPreviousReleaseGeneration(infraDir, applied)).toBe(current);
    expect(services.readAppliedRelease(infraDir)?.manifest.release).toBe("release-1");
    expect(services.readGenerationConfiguration(infraDir, applied).selectedRoots).toEqual(
      services.readGenerationConfiguration(infraDir, previous).selectedRoots,
    );
    expect(services.readDesiredSelection(infraDir).roots).toEqual(["alpha", "data-manager"]);
    const compose = readFileSync(
      join(infraDir, services.CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
      "utf8",
    );
    expect(compose).toContain(manifest("release-1", "1").images["data-manager"]);
    expect(applyGeneratedHardlinksBeforeStart).toHaveBeenCalled();
    expect(vi.mocked(dockerComposeStream).mock.calls.map((call) => call[0])).toEqual([
      ["up", "-d", "--no-deps", "alpha"],
      ["up", "-d", "--no-deps", "data-manager"],
    ]);
    const audit = readFileSync(join(infraDir, "state/ops-agent/control-audit.jsonl"), "utf8");
    const lastAudit = audit.trim().split("\n").at(-1);
    assert.isDefined(lastAudit);
    expect(JSON.parse(lastAudit)).toMatchObject({
      action: "rollback",
      from: current,
      to: previous,
      exitCode: 0,
    });
  });

  it("stops at the first service that fails to recreate and releases the lease", async () => {
    await render(["alpha", "postgis"], manifest("release-1", "1", 100));
    await render(["alpha", "postgis", "ops-agent"], manifest("release-2", "2", 200));
    newestAppliedMigration(100);
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    await expect(rollback("--yes")).rejects.toThrow("exit:3");
    expect(vi.mocked(dockerComposeStream).mock.calls.map((call) => call[0])).toEqual([
      ["up", "-d", "--no-deps", "alpha"],
      ["up", "-d", "--no-deps", "postgis"],
    ]);
    expect(printed.join("\n")).toContain("Recreating postgis failed (exit 3)");
    expect(printed.join("\n")).toContain("run `pnpm openmapx compose up` to finish");
    expect(
      openLeaseStore({ directory: leaseStoreDirectory(infraDir), purpose: "test" }).list(),
    ).toEqual([]);
  });
  it("records the rollback in the audit file when it fails after its commit", async () => {
    await render(["alpha"], manifest("release-1", "1", 100));
    const current = await render(["alpha"], manifest("release-2", "2", 200));
    newestAppliedMigration(100);
    vi.mocked(applyGeneratedHardlinksBeforeStart).mockRejectedValueOnce(new Error("links failed"));
    await expect(rollback("--yes")).rejects.toThrow("links failed");
    expect(services.currentConfigurationGeneration(infraDir)).not.toBe(current);
    const audit = readFileSync(join(infraDir, "state/ops-agent/control-audit.jsonl"), "utf8");
    expect(JSON.parse(audit.trim().split("\n").at(-1) ?? "")).toMatchObject({
      action: "rollback",
      from: current,
      exitCode: null,
      error: "links failed",
    });
  });
});
