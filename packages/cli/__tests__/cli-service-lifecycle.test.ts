import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderComposeForRepo } from "../src/commands/compose";
import { registerServicesCommands } from "../src/commands/services";
import { migrateBeforeApiUpdate } from "../src/lib/api-migrations";
import { dockerComposeStream } from "../src/lib/docker";
import { selectRelease } from "../src/lib/release";

// These exercise fsynced cross-process authority/retention stores; concurrent
// package checks can exceed the generic 15s unit budget on this filesystem.
vi.setConfig({ testTimeout: 60000 });

// Named external Docker process edge; real manifests, renderer, files and command entry remain.
vi.mock("@openmapx/core/build-artifacts", async (original) => {
  const actual = await original<typeof import("@openmapx/core/build-artifacts")>();
  return {
    ...actual,
    executeOwnedGenerationHardlinks: vi.fn(actual.executeOwnedGenerationHardlinks),
  };
});
vi.mock("../src/lib/docker", async (original) => ({
  ...(await original<typeof import("../src/lib/docker")>()),
  dockerComposeStream: vi.fn(),
}));
vi.mock("../src/lib/api-migrations", async (original) => ({
  ...(await original<typeof import("../src/lib/api-migrations")>()),
  migrateBeforeApiUpdate: vi.fn(),
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
  vi.mocked(migrateBeforeApiUpdate).mockReset().mockResolvedValue(0);
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
function expectConfigurationWriterFree() {
  expect(existsSync(join(root, "infra/docker/state/ops-agent/configuration/.writer"))).toBe(false);
  expect(
    existsSync(
      join(
        services.releaseStatePaths(join(root, "infra/docker")).store,
        services.RELEASE_STORE_LOCK_NAME,
      ),
    ),
  ).toBe(false);
}
async function commitCompetingGeneration() {
  services.writeServiceSelectionFile(join(root, "infra/docker"), ["alpha"]);
  return (await renderComposeForRepo({ rootDir: root, domain: "example.test" })).revisionId;
}
function command(action: "start" | "update", args: string[] = [], target = "alpha") {
  const program = new Command();
  registerServicesCommands(program);
  return program
    .parseAsync(["services", action, target, ...args], { from: "user" })
    .catch((error) => {
      if (String(error).includes("exit:0")) throw error;
      throw Error(
        `${String(error)}; command diagnostics: ${JSON.stringify(vi.mocked(console.error).mock.calls)}`,
      );
    });
}
function lifecycleEnvelope(name: string) {
  return JSON.parse(
    readFileSync(join(root, "infra/docker/data/ops-agent/lifecycle", name), "utf8"),
  );
}
function lifecycleOperationKeys() {
  return readdirSync(join(root, "infra/docker/data/ops-agent/lifecycle")).map((name) =>
    name.replace(/\.json$/, ""),
  );
}
function retainedReceipts() {
  const dataRoot = join(root, "infra/docker/data");
  return Promise.all(
    lifecycleOperationKeys().map((key) =>
      services.readServiceLifecycleReceipt({
        dataRoot,
        execution: lifecycleEnvelope(`${key}.json`).seed.payload.execution,
      }),
    ),
  );
}
async function retainedReceipt() {
  const receipts = await retainedReceipts();
  expect(receipts).toHaveLength(1);
  return receipts[0]!;
}
function targetLocks() {
  const directory = join(root, "infra/docker/data/.admin-target-control/locks");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}
/** A selection whose rendered hardlink plan has one entry, so a Start issues a child to data-manager. */
async function renderWithHardlinkPlan() {
  const edit = (id: string, change: (manifest: Record<string, unknown>) => void) => {
    const path = join(root, "services", id, "service.json"),
      manifest = JSON.parse(readFileSync(path, "utf8"));
    change(manifest);
    writeFileSync(path, JSON.stringify(manifest));
  };
  edit("alpha", (manifest) => {
    manifest.produces = [{ type: "fixture-data", sourceDir: "data/fixture" }];
  });
  edit("beta", (manifest) => {
    manifest.consumes = [
      { type: "fixture-data", mountAt: "/data", readOnly: true, required: false },
    ];
  });
  await renderComposeForRepo({ rootDir: root, domain: "example.test" });
}
/** Reports data-manager as ready and refuses everything else, so an issued child never completes. */
async function unreachableHardlinkExecutor() {
  const server: Server = createServer((request, response) => {
    const ready = request.method === "GET" && request.url?.endsWith("/status");
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        ready
          ? { ok: true, status: "ready", phase: "complete", uptime: 1, dataDir: "/data" }
          : { error: "unavailable" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Fixture server has no port");
  vi.stubEnv("DATA_MANAGER_URL", `http://127.0.0.1:${address.port}`);
  return () => new Promise((resolve) => server.close(resolve));
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
  it("does not hold the configuration writer while docker compose runs for Start", async () => {
    vi.mocked(dockerComposeStream).mockImplementation(async () => {
      expectConfigurationWriterFree();
      return 0;
    });
    await expect(command("start")).rejects.toThrow("exit:0");
    expect(dockerComposeStream).toHaveBeenCalledTimes(1);
  });
  it("does not hold the configuration writer across Update pull, migration and recreation", async () => {
    const directory = join(root, "services/app-api");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "service.json"),
      JSON.stringify({
        id: "app-api",
        name: "app-api",
        version: "1.0.0",
        quality: "built-in",
        container: { image: "fixture/app-api", tag: "1" },
      }),
    );
    services.writeServiceSelectionFile(join(root, "infra/docker"), ["alpha", "app-api", "beta"]);
    await renderComposeForRepo({ rootDir: root, domain: "example.test" });
    const order: string[] = [];
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      expectConfigurationWriterFree();
      order.push(args[0]!);
      return 0;
    });
    vi.mocked(migrateBeforeApiUpdate).mockImplementation(async () => {
      expectConfigurationWriterFree();
      order.push("migrate");
      return 0;
    });
    await expect(command("update", [], "app-api")).rejects.toThrow("exit:0");
    expect(order).toEqual(["pull", "migrate", "up"]);
    expect(await retainedReceipt()).toMatchObject({ phase: "complete", followUp: "complete" });
  });
  it("refuses to commit or recreate when another writer moves the generation during pull", async () => {
    let competing: string | undefined;
    vi.mocked(dockerComposeStream).mockImplementation(async () => {
      competing = await commitCompetingGeneration();
      return 0;
    });
    await expect(command("update")).rejects.toThrow("exit:1");
    expect(vi.mocked(dockerComposeStream).mock.calls.map((call) => call[0])).toEqual([
      ["pull", "alpha"],
    ]);
    expect(services.currentConfigurationGeneration(join(root, "infra/docker"))).toBe(competing);
    expect(await retainedReceipt()).toMatchObject({
      phase: "failed",
      finalRevisionId: null,
      commit: "not_committed",
      failure: { reason: "revision_conflict", failedServiceIds: ["alpha"] },
    });
    expect(targetLocks()).toEqual([]);
  });
  it("refuses recreation when the generation moves after its pre-commit checks", async () => {
    let final: string | undefined;
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      if (args[0] !== "up") return 0;
      final = services.currentConfigurationGeneration(join(root, "infra/docker")) ?? undefined;
      await commitCompetingGeneration();
      return 0;
    });
    await expect(command("update")).rejects.toThrow("exit:1");
    const receipt = await retainedReceipt();
    expect(receipt).toMatchObject({
      phase: "failed",
      commit: "final_committed",
      followUp: "unknown",
      finalRevisionId: final,
      failure: { reason: "revision_conflict", failedServiceIds: ["alpha"] },
    });
    expect(services.currentConfigurationGeneration(join(root, "infra/docker"))).not.toBe(final);
    expect(targetLocks()).toEqual([]);
  });
  it("refuses to record Start when the generation moves while compose runs", async () => {
    let competing: string | undefined;
    vi.mocked(dockerComposeStream).mockImplementation(async () => {
      competing = await commitCompetingGeneration();
      return 0;
    });
    await expect(command("start")).rejects.toThrow("exit:1");
    expect(dockerComposeStream).toHaveBeenCalledTimes(1);
    expect(services.currentConfigurationGeneration(join(root, "infra/docker"))).toBe(competing);
    expect(await retainedReceipt()).toMatchObject({
      phase: "failed",
      commit: "final_committed",
      followUp: "unknown",
      failure: { reason: "revision_conflict", failedServiceIds: ["alpha"] },
    });
    expect(targetLocks()).toEqual([]);
  });
  it("holds physical target ownership through target-only Start after full-selection preparation", async () => {
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      expect(args).toEqual(["up", "-d", "alpha"]);
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
    expect(existsSync(join(root, "infra/docker/state/ops-agent/configuration/.writer"))).toBe(
      false,
    );
  });
  it("pulls under ownership before committing a full final generation and recreating only the target", async () => {
    const calls: string[][] = [];
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      calls.push([...args]);
      expect(existsSync(join(root, "infra/docker/data/.admin-target-control/locks/alpha"))).toBe(
        true,
      );
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
  it("refuses recreation when the release selection changes during pull", async () => {
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
    const infraDir = join(root, "infra/docker");
    const path = services.releaseStatePaths(infraDir).overlay;
    vi.mocked(dockerComposeStream).mockImplementation(async () => {
      await selectRelease({
        infraDir,
        resolve: async () => manifest,
        docker: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      });
      return 0;
    });
    await expect(command("update")).rejects.toThrow("exit:1");
    expect(existsSync(path)).toBe(true);
    expect(vi.mocked(dockerComposeStream).mock.calls.map((call) => call[0])).toEqual([
      ["pull", "alpha"],
    ]);
    expect(services.currentConfigurationGeneration(join(root, "infra/docker"))).toBe(seed);
    expect(await retainedReceipt()).toMatchObject({
      phase: "failed",
      finalRevisionId: null,
      commit: "not_committed",
    });
  });
  it("records the signed last phase and releases targets when canceled after pull before generation commit", async () => {
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
      failure: { reason: "pull", failedServiceIds: ["alpha"] },
    });
    expect(targetLocks()).toEqual([]);
    expect(existsSync(join(root, "infra/docker/state/ops-agent/configuration/.writer"))).toBe(
      false,
    );
  });
  it("records failure when the execution deadline passes during pull", async () => {
    vi.mocked(dockerComposeStream).mockImplementation(async () => {
      const directory = join(root, "infra/docker/data/ops-agent/lifecycle"),
        envelope = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]!), "utf8"));
      vi.spyOn(Date, "now").mockReturnValue(envelope.seed.payload.execution.deadlineAt + 1);
      return 0;
    });
    await expect(command("update")).rejects.toThrow("exit:1");
    expect(vi.mocked(dockerComposeStream).mock.calls.map((call) => call[0])).toEqual([
      ["pull", "alpha"],
    ]);
    expect(await retainedReceipt()).toMatchObject({
      phase: "failed",
      finalRevisionId: null,
      commit: "not_committed",
      followUp: "not_started",
      failure: { reason: "pull", failedServiceIds: ["alpha"] },
    });
  });
  it("keeps the original failure and warns when its receipt cannot be recorded", async () => {
    vi.mocked(dockerComposeStream).mockImplementation(async () => {
      mkdirSync(join(root, "infra/docker/state/ops-agent/configuration/.writer"), { mode: 0o700 });
      return 7;
    });
    await expect(command("update")).rejects.toThrow("exit:7");
    expect(
      vi.mocked(console.error).mock.calls.some((call) => String(call[0]).includes("not recorded")),
    ).toBe(true);
    expect(await retainedReceipt()).toMatchObject({
      phase: "pins_validated",
      finalRevisionId: null,
    });
    expect(targetLocks()).toEqual(["alpha", "beta"]);
  });
  it("records its signed final revision and releases targets when recreation fails after commit", async () => {
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
    expect(targetLocks()).toEqual([]);
    expect(existsSync(join(root, "infra/docker/state/ops-agent/configuration/.writer"))).toBe(
      false,
    );
  });
  it("a failed compose up releases every target and the next start succeeds", async () => {
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(1);
    await expect(command("start")).rejects.toThrow("exit:1");
    expect(await retainedReceipt()).toMatchObject({
      phase: "failed",
      failure: { reason: "recreate", failedServiceIds: ["alpha"] },
    });
    await expect(command("start")).rejects.toThrow("exit:0");
    expect(dockerComposeStream).toHaveBeenCalledTimes(2);
    expect(targetLocks()).toEqual([]);
  });
  it("a retry after a partial start converges when some containers are already up", async () => {
    const running = new Set<string>();
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      // Compose leaves running containers alone, so a retry must not ask it to recreate them.
      expect(args.slice(0, 2)).toEqual(["up", "-d"]);
      expect(args).not.toContain("--force-recreate");
      if (running.size === 0) {
        running.add("alpha");
        return 1;
      }
      for (const id of args.slice(2)) running.add(id);
      return 0;
    });
    await expect(command("start", ["beta"])).rejects.toThrow("exit:1");
    expect([...running]).toEqual(["alpha"]);
    await expect(command("start", ["beta"])).rejects.toThrow("exit:0");
    expect([...running].sort()).toEqual(["alpha", "beta"]);
    expect(vi.mocked(dockerComposeStream).mock.calls.map((call) => call[0])).toEqual([
      ["up", "-d", "alpha", "beta"],
      ["up", "-d", "alpha", "beta"],
    ]);
    expect((await retainedReceipts()).map((receipt) => receipt.phase).sort()).toEqual([
      "complete",
      "failed",
    ]);
    expect(targetLocks()).toEqual([]);
  });
  it("a failure after an issued hardlink child keeps the lease", async () => {
    await renderWithHardlinkPlan();
    const stop = await unreachableHardlinkExecutor();
    try {
      await expect(command("start")).rejects.toThrow("exit:1");
    } finally {
      await stop();
    }
    expect(dockerComposeStream).not.toHaveBeenCalled();
    expect(targetLocks()).toEqual(["alpha", "beta"]);
    const receipt = await retainedReceipt();
    expect(receipt).toMatchObject({
      phase: "failed",
      commit: "final_committed",
      followUp: "unknown",
      failure: { reason: "hardlinks", failedServiceIds: ["alpha"] },
    });
    const diagnostics = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(diagnostics).toContain(
      `recover-update --operation-key ${receipt.execution.operationKey}`,
    );
    expect(diagnostics).not.toContain("No automated release exists");
  });
  it("does not offer recover-update when Start fails after its hardlink child committed", async () => {
    await renderWithHardlinkPlan();
    const stop = await unreachableHardlinkExecutor();
    vi.mocked(control.executeOwnedGenerationHardlinks).mockImplementationOnce(
      async ({ authority, lease }) => {
        const installation = control.executionAuthorityState(authority).installation.installation,
          { reservation } = control.readGenerationHardlinksOwnerPlan(authority);
        if (!reservation) throw Error("Fixture plan has no hardlink reservation");
        await control.bindControlChildPhase(authority, reservation);
        await control.issueControlChildPhase(authority, {
          phase: "hardlinks",
          ordinal: reservation.ordinal,
          childPublicKey: control.controlRolePublicKey(installation, "data-manager"),
          lease,
        });
        return { applied: true, entries: 1, linked: 1, skipped: 0, pruned: 0, via: "data-manager" };
      },
    );
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(1);
    try {
      await expect(command("start")).rejects.toThrow("exit:1");
    } finally {
      await stop();
    }
    expect(targetLocks()).toEqual(["alpha", "beta"]);
    const receipt = await retainedReceipt();
    expect(receipt).toMatchObject({
      phase: "failed",
      hardlinks: { applied: true },
      failure: { reason: "recreate", failedServiceIds: ["alpha"] },
    });
    const diagnostics = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(diagnostics).toContain(`Operation ${receipt.execution.operationKey} keeps`);
    expect(diagnostics).toContain("a hardlink child was issued to data-manager");
    expect(diagnostics).toContain("No automated release exists yet");
    expect(diagnostics).not.toContain("recover-update --operation-key");
    expect(diagnostics).not.toContain("may still be running");
  });
  it("a lease held by a live operation still refuses a second start", async () => {
    let refusal: unknown;
    let holder = "";
    vi.mocked(dockerComposeStream).mockImplementationOnce(async () => {
      holder = lifecycleOperationKeys()[0]!;
      refusal = await command("start").catch((error) => error);
      expect(targetLocks()).toEqual(["alpha", "beta"]);
      return 0;
    });
    await expect(command("start")).rejects.toThrow("exit:0");
    expect(String(refusal)).toContain("exit:1");
    expect(String(refusal)).toContain(`operation ${holder}`);
    expect(String(refusal)).toContain(`ops-agent/lifecycle/${holder}.json`);
    expect(dockerComposeStream).toHaveBeenCalledTimes(1);
    expect(targetLocks()).toEqual([]);
  });
  it("releases every target when the lifecycle fails before its receipt opens", async () => {
    const paths = services.releaseStatePaths(join(root, "infra/docker"));
    services.ensureReleaseStateDirectory(paths.directory);
    services.ensureReleaseStateDirectory(paths.store);
    const lock = await services.acquireReleaseStoreLock(paths.store, {}, { failIfBusy: true });
    try {
      await expect(command("start")).rejects.toThrow("Release store is busy");
    } finally {
      lock.release();
    }
    expect(dockerComposeStream).not.toHaveBeenCalled();
    expect(targetLocks()).toEqual([]);
    await expect(command("start")).rejects.toThrow("exit:0");
  });
  it("waits for a momentary release-store holder once containers have started", async () => {
    vi.mocked(dockerComposeStream).mockImplementationOnce(async () => {
      const paths = services.releaseStatePaths(join(root, "infra/docker"));
      const lock = await services.acquireReleaseStoreLock(paths.store, {}, { failIfBusy: true });
      setTimeout(() => lock.release(), 300);
      return 0;
    });
    await expect(command("start")).rejects.toThrow("exit:0");
    expect(await retainedReceipt()).toMatchObject({ phase: "complete", followUp: "complete" });
  });
  it("refuses to replace services when the generation moves during the migration", async () => {
    const directory = join(root, "services/app-api");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "service.json"),
      JSON.stringify({
        id: "app-api",
        name: "app-api",
        version: "1.0.0",
        quality: "built-in",
        container: { image: "fixture/app-api", tag: "1" },
      }),
    );
    services.writeServiceSelectionFile(join(root, "infra/docker"), ["alpha", "app-api", "beta"]);
    await renderComposeForRepo({ rootDir: root, domain: "example.test" });
    vi.mocked(migrateBeforeApiUpdate).mockImplementation(async () => {
      await commitCompetingGeneration();
      return 0;
    });
    await expect(command("update", [], "app-api")).rejects.toThrow("exit:1");
    expect(vi.mocked(dockerComposeStream).mock.calls.map((call) => call[0])).toEqual([
      ["pull", "app-api"],
    ]);
    expect(await retainedReceipt()).toMatchObject({
      phase: "failed",
      commit: "final_committed",
      failure: { reason: "revision_conflict", failedServiceIds: ["app-api"] },
    });
    expect(targetLocks()).toEqual([]);
  });
});
