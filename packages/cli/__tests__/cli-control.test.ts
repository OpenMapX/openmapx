import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { settleDataConfigurationFence } from "@openmapx/core/data-manager-sdk";
import type { ExecutionRef } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerControlCommands } from "../src/commands/control";
import { dockerCompose } from "../src/lib/docker";

vi.mock("../src/lib/docker", async (original) => ({
  ...(await original<typeof import("../src/lib/docker")>()),
  dockerCompose: vi.fn(),
}));
vi.mock("@openmapx/core/data-manager-sdk", async (original) => ({
  ...(await original<typeof import("@openmapx/core/data-manager-sdk")>()),
  settleDataConfigurationFence: vi.fn(),
}));

let root: string;
let infraDir: string;
let printed: string[];
let warned: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-control-"));
  infraDir = join(root, "infra/docker");
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(infraDir, { recursive: true });
  vi.stubEnv("OPENMAPX_ROOT_DIR", root);
  printed = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    printed.push(String(line));
  });
  warned = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    warned.push(String(line));
  });
  vi.mocked(settleDataConfigurationFence).mockReset();
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw Error(`exit:${code}`);
  });
  vi.mocked(dockerCompose)
    .mockReset()
    .mockResolvedValue({
      exitCode: 0,
      stdout: "alpha running\n",
      stderr: "",
    } as Awaited<ReturnType<typeof dockerCompose>>);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerControlCommands(program);
  await expect(program.parseAsync(["node", "openmapx", "control", ...args])).rejects.toThrow(
    "exit:0",
  );
}
function owner(): ExecutionRef {
  return {
    executor: "host-cli",
    principal: "host-cli",
    executionId: randomUUID(),
    operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
    operationFingerprint: "a".repeat(64),
    fingerprint: "b".repeat(64),
    deadlineAt: Date.now() + 60_000,
  };
}
const store = () =>
  control.openLeaseStore({ directory: control.leaseStoreDirectory(infraDir), purpose: "test" });
async function held(ownerKind = "service.stop") {
  const execution = owner();
  await control
    .localLeaseBackend(store())
    .acquire({ owner: execution, ownerKind, targets: ["alpha"] });
  return execution;
}
const auditLog = () =>
  readFileSync(join(control.leaseStoreDirectory(infraDir), "control-audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

describe("openmapx control", () => {
  it("shows held leases with their owner and targets", async () => {
    const execution = await held();
    await run("status");
    const text = printed.join("\n");
    expect(text).toContain(execution.operationKey);
    expect(text).toContain("targets: alpha");
  });

  it("clears the lease of an operation, prints what runs and audits it", async () => {
    const execution = await held();
    await run("clear", "--op", execution.operationKey);
    expect(store().list()).toEqual([]);
    expect(printed.join("\n")).toContain("alpha: running");
    expect(auditLog()).toMatchObject([
      { action: "clear", operationKey: execution.operationKey, lease: { targets: ["alpha"] } },
    ]);
  });

  it("resolves an operation's unknown outcome and releases its targets", async () => {
    const execution = await held("service.restart");
    await run("resolve", "--op", execution.operationKey, "--as", "failed");
    expect(store().list()).toEqual([]);
    expect(auditLog()).toMatchObject([
      { action: "resolve", operationKey: execution.operationKey, as: "failed" },
    ]);
  });

  it("clears a lock by its file name and records the holder it removed", async () => {
    const path = join(control.leaseStoreDirectory(infraDir), "leases.lock");
    mkdirSync(control.leaseStoreDirectory(infraDir), { recursive: true });
    const holder = {
      version: 1,
      purpose: "gone writer",
      pid: 1,
      startTime: null,
      bootId: null,
      pidNamespace: "elsewhere",
      containerId: null,
      acquiredAt: Date.now(),
      nonce: "d".repeat(32),
    };
    writeFileSync(path, JSON.stringify(holder));
    expect(services.readLockHolder(path)).toEqual(holder);
    await run("clear", "--lock", "leases.lock");
    expect(services.readLockHolder(path)).toBeUndefined();
    expect(auditLog()).toMatchObject([{ action: "clear-lock", lock: "leases.lock", holder }]);
  });

  it("knows every lock name a busy message prints", async () => {
    mkdirSync(control.leaseStoreDirectory(infraDir), { recursive: true });
    const receiptDir = join(root, "receipts");
    mkdirSync(receiptDir, { mode: 0o700 });
    const locks = [
      join(control.leaseStoreDirectory(infraDir), "leases.lock"),
      services.configurationWriterLockPath(infraDir),
      services.backupStoreLockPath(infraDir),
      join(receiptDir, ".update.json.lock"),
    ];
    for (const [index, path] of locks.entries()) {
      mkdirSync(join(path, ".."), { recursive: true });
      const named = index === 3 ? { name: path } : {};
      const busy = await services.withRecoverableLock(
        path,
        { purpose: "live writer", ...named },
        () =>
          services
            .withRecoverableLock(path, { purpose: "second", waitMs: 0, ...named }, () => "")
            .catch((error: Error) => error.message),
      );
      const name = String(busy).match(/control clear --lock ([^`]+)`/)?.[1];
      expect(name).toBeDefined();
      writeFileSync(path, "");
      writeFileSync(`${path}.reclaim`, "");
      await run("clear", "--lock", name!);
      expect(services.readLockHolder(path)).toBeUndefined();
      await run("clear", "--lock", `${name}.reclaim`);
    }
    expect(auditLog()).toHaveLength(8);
  });

  it("warns that clearing a maintenance leaves its fence, which resolve then settles", async () => {
    const agent: ExecutionRef = {
      ...owner(),
      executor: "ops-agent",
      principal: "api",
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
    };
    const evidence = {
      maintenanceId: randomUUID(),
      candidateId: randomUUID(),
      planDigest: "c".repeat(64),
    };
    await store().update((leases) => {
      const lease = control.leaseRules.acquire(
        leases,
        { owner: agent, ownerKind: "configurationMaintenance.prepare", targets: ["alpha"] },
        Date.now(),
      );
      control.leaseRules.delegate(
        leases,
        {
          leaseId: lease.leaseId,
          child: {
            key: randomUUID(),
            parentKey: null,
            parent: agent,
            execution: { ...owner(), executor: "data-manager", principal: "data-manager" },
            kind: "configuration-maintenance.prepare",
            phase: "configuration-fence",
            recipient: "data-manager",
            targets: ["alpha"],
            evidence,
          },
        },
        Date.now(),
      );
    });
    await run("clear", "--op", agent.operationKey);
    expect(store().list()).toEqual([]);
    expect(warned.join("\n")).toContain(
      `fence of this maintenance stays prepared and keeps refusing data jobs until \`openmapx control resolve --op ${agent.operationKey}`,
    );
    await run("resolve", "--op", agent.operationKey, "--as", "failed");
    expect(vi.mocked(settleDataConfigurationFence)).toHaveBeenCalledWith(
      { ...evidence, outcome: "contained" },
      expect.not.objectContaining({ controlAssertion: expect.anything() }),
    );
    expect(auditLog().map((entry) => entry.action)).toEqual(["clear", "resolve"]);
  });
});
