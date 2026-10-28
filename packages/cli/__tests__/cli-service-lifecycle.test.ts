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
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderComposeForRepo } from "../src/commands/compose";
import { registerServicesCommands } from "../src/commands/services";
import { dockerComposeStream } from "../src/lib/docker";
import { selectRelease } from "../src/lib/release";

// These exercise fsynced cross-process authority/retention stores; concurrent
// package checks can exceed the generic 15s unit budget on this filesystem.
vi.setConfig({ testTimeout: 60000 });

// Named external Docker process edge; real manifests, renderer, files and command entry remain.
vi.mock("../src/lib/docker", async (original) => ({
  ...(await original<typeof import("../src/lib/docker")>()),
  dockerComposeStream: vi.fn(),
}));
let root: string;
let seed: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "openmapx-owned-lifecycle-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "infra/docker"), { recursive: true });
  for (const id of ["alpha", "beta"]) {
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
    POSTGRES_PASSWORD: "p".repeat(24),
    BETTER_AUTH_SECRET: "a".repeat(32),
    DATA_MANAGER_AUTH_TOKEN: "d".repeat(32),
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("OPENMAPX_ENABLED_SERVICES", "");
  services.writeServiceSelectionFile(join(root, "infra/docker"), ["alpha", "beta"]);
  seed = (await renderComposeForRepo({ rootDir: root, domain: "example.test" })).revisionId;
  vi.mocked(dockerComposeStream).mockReset().mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw Error(`exit:${code}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});
function command(action: "start" | "update", args: string[] = []) {
  const program = new Command();
  registerServicesCommands(program);
  return program
    .parseAsync(["services", action, "alpha", ...args], { from: "user" })
    .catch((error) => {
      if (String(error).includes("exit:0")) throw error;
      throw Error(
        `${String(error)}; command diagnostics: ${JSON.stringify(vi.mocked(console.error).mock.calls)}`,
      );
    });
}
async function retainedReceipt() {
  const dataRoot = join(root, "infra/docker/data"),
    directory = join(dataRoot, "ops-agent/lifecycle");
  const names = readdirSync(directory);
  expect(names).toHaveLength(1);
  const envelope = JSON.parse(readFileSync(join(directory, names[0]!), "utf8"));
  return services.readServiceLifecycleReceipt({
    dataRoot,
    execution: envelope.seed.payload.execution,
  });
}
describe("actual CLI service lifecycle preparation", () => {
  it.each(["data-manager", "alpha"])(
    "refuses ordinary CLI Update of %s when it would recreate the coordinator",
    async (target) => {
      const directory = join(root, "services/data-manager");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "service.json"),
        JSON.stringify({
          id: "data-manager",
          name: "data-manager",
          version: "1.0.0",
          quality: "built-in",
          container: { image: "fixture/data-manager", tag: "1" },
        }),
      );
      if (target === "alpha") {
        const path = join(root, "services/alpha/service.json"),
          manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.container.dependsOn = [{ service: "data-manager" }];
        writeFileSync(path, JSON.stringify(manifest));
      }
      services.writeServiceSelectionFile(join(root, "infra/docker"), [
        "alpha",
        "beta",
        "data-manager",
      ]);
      seed = (await renderComposeForRepo({ rootDir: root, domain: "example.test" })).revisionId;
      const program = new Command();
      registerServicesCommands(program);
      await expect(
        program.parseAsync(["services", "update", target], { from: "user" }),
      ).rejects.toThrow("exit:1");
      expect(vi.mocked(dockerComposeStream).mock.calls).toHaveLength(0);
      expect(services.currentConfigurationGeneration(join(root, "infra/docker"))).toBe(seed);
    },
  );
  it("holds writer and physical target ownership through target-only Start after full-selection preparation", async () => {
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      expect(args).toEqual(["up", "-d", "alpha"]);
      expect(existsSync(join(root, "infra/docker/.trusted-config-writer"))).toBe(true);
      expect(existsSync(join(root, "infra/docker/data/.admin-target-control/locks/alpha"))).toBe(
        true,
      );
      expect(
        JSON.parse(
          readFileSync(
            services.currentConfigurationFile(
              join(root, "infra/docker"),
              services.SERVICE_SELECTION_FILE,
            ),
            "utf8",
          ),
        ).selected,
      ).toEqual(["alpha", "beta"]);
      return 0;
    });
    await expect(command("start")).rejects.toThrow("exit:0");
    expect(dockerComposeStream).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, "infra/docker/.trusted-config-writer"))).toBe(false);
  });
  it("pulls under ownership before committing a full final generation and recreating only the target", async () => {
    const calls: string[][] = [];
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      calls.push([...args]);
      expect(existsSync(join(root, "infra/docker/.trusted-config-writer"))).toBe(true);
      if (args[0] === "pull")
        expect(services.currentConfigurationGeneration(join(root, "infra/docker"))).toBe(seed);
      else {
        expect(services.currentConfigurationGeneration(join(root, "infra/docker"))).not.toBe(seed);
        expect(
          JSON.parse(
            readFileSync(
              services.currentConfigurationFile(
                join(root, "infra/docker"),
                services.SERVICE_SELECTION_FILE,
              ),
              "utf8",
            ),
          ).selected,
        ).toEqual(["alpha", "beta"]);
      }
      return 0;
    });
    await expect(command("update")).rejects.toThrow("exit:0");
    expect(calls).toEqual([
      ["pull", "alpha"],
      ["up", "-d", "--force-recreate", "alpha"],
    ]);
  });
  it("applies no-deps only to recreation while retaining the full selected generation", async () => {
    await expect(command("update", ["--no-deps"])).rejects.toThrow("exit:0");
    expect(vi.mocked(dockerComposeStream).mock.calls.map((call) => call[0])).toEqual([
      ["pull", "alpha"],
      ["up", "-d", "--force-recreate", "--no-deps", "alpha"],
    ]);
    const receipt = await retainedReceipt();
    expect(receipt).toMatchObject({
      phase: "complete",
      noDeps: true,
      followUp: "complete",
      commit: "final_committed",
    });
    expect(
      JSON.parse(
        readFileSync(
          services.currentConfigurationFile(
            join(root, "infra/docker"),
            services.SERVICE_SELECTION_FILE,
          ),
          "utf8",
        ),
      ).selected,
    ).toEqual(["alpha", "beta"]);
  });
  it("retains failed pull evidence without committing a final generation or recreating", async () => {
    vi.mocked(dockerComposeStream).mockResolvedValue(7);
    await expect(command("update")).rejects.toThrow("exit:7");
    expect(vi.mocked(dockerComposeStream).mock.calls.map((call) => call[0])).toEqual([
      ["pull", "alpha"],
    ]);
    expect(services.currentConfigurationGeneration(join(root, "infra/docker"))).toBe(seed);
    expect(await retainedReceipt()).toMatchObject({
      phase: "failed",
      expectedRevisionId: seed,
      finalRevisionId: null,
      commit: "not_committed",
      followUp: "not_started",
      failure: { reason: "pull", failedServiceIds: ["alpha"] },
    });
  });
  it("excludes actual release reselection throughout Update pull and recreation", async () => {
    const manifest = services.parseReleaseManifest(
      JSON.stringify({
        schemaVersion: 1,
        release: "synthetic-next",
        images: Object.fromEntries(
          services.RELEASE_IMAGE_NAMES.map((name) => [
            name,
            `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`,
          ]),
        ),
        privacyReleaseValidation: {
          version: 1,
          sourceBuildFingerprint: "2".repeat(64),
          validatedAt: "2026-09-05T12:00:00.000Z",
          checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
        },
      }),
      "ghcr.io/openmapx",
    );
    const path = join(root, "infra/docker/docker-compose.release.yml");
    vi.mocked(dockerComposeStream).mockImplementation(async () => {
      await expect(selectRelease({ path, resolve: async () => manifest })).rejects.toThrow(
        "Release store is busy",
      );
      expect(existsSync(path)).toBe(false);
      return 0;
    });
    await expect(command("update")).rejects.toThrow("exit:0");
    expect(await retainedReceipt()).toMatchObject({
      phase: "complete",
      commit: "final_committed",
      followUp: "complete",
    });
  });
  it("retains the original fence and signed last phase when canceled after pull before generation commit", async () => {
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      expect(args).toEqual(["pull", "alpha"]);
      const control = await import("@openmapx/core/build-artifacts"),
        dataRoot = join(root, "infra/docker/data"),
        directory = join(dataRoot, "ops-agent/lifecycle"),
        envelope = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]!), "utf8")),
        installation = control.openControlInstallation({
          infraDir: join(root, "infra/docker"),
          role: "host-cli",
          serviceIds: ["alpha", "beta"],
        });
      try {
        control.cancelControlExecution(
          control.restoreAdmittedControlExecution(installation, envelope.seed.payload.execution),
        );
      } finally {
        control.closeControlInstallation(installation);
      }
      return 0;
    });
    await expect(command("update")).rejects.toBeInstanceOf(Error);
    expect(vi.mocked(dockerComposeStream).mock.calls.map((call) => call[0])).toEqual([
      ["pull", "alpha"],
    ]);
    expect(services.currentConfigurationGeneration(join(root, "infra/docker"))).toBe(seed);
    expect(await retainedReceipt()).toMatchObject({
      phase: "failed",
      finalRevisionId: null,
      commit: "not_committed",
      followUp: "not_started",
    });
    expect(existsSync(join(root, "infra/docker/data/.admin-target-control/locks/alpha"))).toBe(
      true,
    );
    expect(existsSync(join(root, "infra/docker/.trusted-config-writer"))).toBe(false);
  });
  it("retains its signed final revision and target fence when recreation fails after commit", async () => {
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => (args[0] === "pull" ? 0 : 9));
    await expect(command("update")).rejects.toThrow("exit:9");
    const receipt = await retainedReceipt();
    expect(receipt).toMatchObject({
      phase: "failed",
      expectedRevisionId: seed,
      commit: "final_committed",
      followUp: "unknown",
      failure: { reason: "recreate", failedServiceIds: ["alpha"] },
    });
    expect(receipt.finalRevisionId).toBe(
      services.currentConfigurationGeneration(join(root, "infra/docker")),
    );
    expect(receipt.finalRevisionId).not.toBe(seed);
    expect(existsSync(join(root, "infra/docker/data/.admin-target-control/locks/alpha"))).toBe(
      true,
    );
    expect(existsSync(join(root, "infra/docker/.trusted-config-writer"))).toBe(false);
  });
});
