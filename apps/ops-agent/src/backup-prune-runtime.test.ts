import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey, OpsClient } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterEach, expect, it, vi } from "vitest";
import { ownedServiceHost } from "./__fixtures__/owned-service-host";
import { assertBackupPrunePreview } from "./backup-prune-runtime";
import { openOpsJobJournal } from "./journal";
import { buildOpsAgentServer } from "./server";

const removal = vi.hoisted(() => ({ active: false, entered: () => {}, held: Promise.resolve() }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (removal.active && String(args[0]).endsWith("/manifest.json")) {
        removal.active = false;
        removal.entered();
        await removal.held;
      }
      return actual.unlink(...args);
    },
  };
});

afterEach(() => vi.unstubAllEnvs());
it("awaits the actual held filesystem deletion before settling cancellation and preserves its completed result", async () => {
  vi.stubEnv("BACKUP_RETENTION_DAYS", "30");
  const host = await ownedServiceHost(),
    old = join(host.infraDir, "backups", "old");
  mkdirSync(old, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(old, "manifest.json"),
    JSON.stringify({
      name: "old",
      formatVersion: 2,
      createdAt: new Date(Date.now() - 40 * 86400000).toISOString(),
      services: [],
    }),
    { mode: 0o600 },
  );
  const installation = openControlInstallation({
      infraDir: host.infraDir,
      role: "ops-agent",
      serviceIds: ["motis"],
    }),
    journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json")),
    app = buildOpsAgentServer({
      runtime: host.runtime,
      journal,
      resourceClaimer: host.claimer,
      controlInstallation: installation,
      tokens: { api: host.token, "data-manager": "d".repeat(43) },
    });
  const tokenFile = join(host.root, "api-token");
  writeFileSync(tokenFile, host.token, { mode: 0o600 });
  const client = new OpsClient({
    baseUrl: await app.listen({ host: "127.0.0.1", port: 0 }),
    tokenFile,
  });
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    removal.entered = resolve;
  });
  removal.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const preview = await client.execute({ kind: "backup.prune.preview" });
    if (preview.execution !== "sync") throw Error("Preview missing");
    removal.active = true;
    const deadline = Date.now() + 30000,
      admitted = await client.execute(
        { kind: "backup.prune", proof: preview.value.proof },
        {
          operationKey: createControlRootOperationKey({
            notAfter: deadline,
            nonce: randomBytes(16),
          }),
          execution: { requestedDeadlineAt: deadline },
        },
      );
    if (admitted.execution !== "async") throw Error("Prune execution missing");
    await entered;
    const running = await client.status("backup.prune", admitted.operationId);
    await client.cancel(admitted.operationId, { fingerprint: running.fingerprint });
    const pending = await client.status("backup.prune", admitted.operationId);
    expect(pending.state).toBe("termination_pending");
    expect(
      journal.records().find((job) => job.operationId === admitted.operationId)?.terminalAt,
    ).toBeUndefined();
    expect(existsSync(old)).toBe(true);
    release();
    await vi.waitFor(
      async () => {
        const terminal = await client.status("backup.prune", admitted.operationId);
        expect(terminal.state).toBe("succeeded");
        expect(terminal.result).toMatchObject({ deleted: ["old"] });
      },
      { timeout: 10000 },
    );
    expect(existsSync(old)).toBe(false);
  } finally {
    release();
    removal.active = false;
    await app.close();
    closeControlInstallation(installation);
    rmSync(host.cleanupRoot, { recursive: true, force: true });
  }
}, 30000);
it("previews and prunes only the unchanged original eligible set through the production agent", async () => {
  vi.stubEnv("BACKUP_RETENTION_DAYS", "30");
  const host = await ownedServiceHost(),
    root = join(host.infraDir, "backups");
  function archive(name: string, ageDays: number) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        formatVersion: 2,
        name,
        createdAt: new Date(Date.now() - ageDays * 86400000).toISOString(),
        openmapxVersion: "1.0.0",
        services: [],
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(dir, "archive.tar.gz"), "synthetic prepared backup", { mode: 0o600 });
    return dir;
  }
  const old = archive("old", 40),
    fresh = archive("fresh", 2),
    original = readFileSync(join(old, "manifest.json")),
    tokenFile = join(host.root, "api-token");
  writeFileSync(tokenFile, host.token, { mode: 0o600 });
  const installation = openControlInstallation({
      infraDir: host.infraDir,
      role: "ops-agent",
      serviceIds: ["motis"],
    }),
    journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json")),
    app = buildOpsAgentServer({
      runtime: host.runtime,
      resourceClaimer: host.claimer,
      journal,
      controlInstallation: installation,
      tokens: { api: host.token, "data-manager": "d".repeat(43) },
    });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 }),
    client = new OpsClient({ baseUrl, tokenFile });
  const preview = async () => {
    const result = await client.execute({ kind: "backup.prune.preview" });
    if (result.execution !== "sync") throw Error("Preview must be synchronous");
    return result.value;
  };
  const prune = async (proof: Awaited<ReturnType<typeof preview>>["proof"]) => {
    const deadline = Date.now() + 30000,
      submitted = await client.execute(
        { kind: "backup.prune", proof },
        {
          operationKey: createControlRootOperationKey({
            notAfter: deadline,
            nonce: randomBytes(16),
          }),
          execution: { requestedDeadlineAt: deadline },
        },
      );
    if (submitted.execution !== "async") throw Error("Prune must retain an execution");
    await vi.waitFor(
      async () =>
        expect(["succeeded", "failed"]).toContain(
          (await client.status("backup.prune", submitted.operationId)).state,
        ),
      { timeout: 10000 },
    );
    return client.status("backup.prune", submitted.operationId);
  };
  try {
    const initial = await preview();
    expect(() =>
      assertBackupPrunePreview(host.token, initial.proof, Date.parse(initial.proof.expiresAt)),
    ).toThrow();
    expect(initial.candidates.map((entry) => entry.backupId)).toEqual(["old"]);
    expect(readFileSync(join(old, "manifest.json"))).toEqual(original);
    const path = join(old, "manifest.json");
    writeFileSync(`${path}.new`, original, { mode: 0o600 });
    renameSync(`${path}.new`, path);
    expect((await prune(initial.proof)).state).toBe("failed");
    expect(existsSync(old)).toBe(true);
    const changed = await preview(),
      newcomer = archive("newcomer", 40);
    expect((await prune(changed.proof)).state).toBe("failed");
    expect(existsSync(newcomer)).toBe(true);
    const priorPolicy = await preview();
    await services.commitConfigurationGeneration({
      infraDir: host.infraDir,
      services: host.loaded,
      input: {
        ...services.readAppliedConfiguration(host.infraDir),
        domain: "example.test",
        selectedRoots: ["motis"],
        platform: { version: 1, backupRetentionDays: { source: "database", value: 60 } },
      },
    });
    expect((await prune(priorPolicy.proof)).state).toBe("failed");
    expect(existsSync(old)).toBe(true);
    const current = await preview();
    expect((await prune({ ...current.proof, authenticator: "0".repeat(64) })).state).toBe("failed");
    const completed = await prune(current.proof);
    expect(completed.state).toBe("succeeded");
    expect(completed.result).toMatchObject({ deleted: ["newcomer", "old"], retainedCount: 1 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(newcomer)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(
      host.calls.some(
        (args) => args.includes("up") || args.includes("stop") || args.includes("pull"),
      ),
    ).toBe(false);
  } finally {
    await app.close();
    closeControlInstallation(installation);
    rmSync(host.cleanupRoot, { recursive: true, force: true });
  }
}, 60000);
