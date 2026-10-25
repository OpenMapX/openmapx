import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as c from "@openmapx/core/build-artifacts";
import {
  controlTerminalReceiptDigest,
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
  opsOperationFingerprint,
  parseOpsJobStatus,
  signApiRetentionProof,
} from "@openmapx/core/ops";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { openOpsJobJournal, type PersistedOpsJob } from "./journal";
import { buildOpsAgentServer } from "./server";
import { initializeTerminalClaimCleanup } from "./trusted-config-source";

let bundle: string, bundleRoot: string;
beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), "omx-terminal-process-"));
  bundle = join(bundleRoot, "agent.mjs");
  await build({
    entryPoints: [join(import.meta.dirname, "test-fixtures/terminal-retention-process.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: bundle,
    banner: {
      js: `import {createRequire} from "node:module"; const require=createRequire(${JSON.stringify(join(import.meta.dirname, "../package.json"))});`,
    },
  });
});
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
interface Interrupted {
  job: PersistedOpsJob;
  apiJobId: string;
  attemptId: string;
}
async function interrupt(
  root: string,
  boundary: string,
  outcome: string,
  borrowed?: { assertion: string; execution: ExecutionRef },
): Promise<Interrupted> {
  const child = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const stopped = new Promise<Interrupted>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(Error(`Fixture exited ${code}/${signal}: ${stderr}`)),
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) {
        try {
          resolve(JSON.parse(stdout.split("\n")[0] ?? ""));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
  child.stdin.end(JSON.stringify({ root, boundary, outcome, borrowed }));
  try {
    return await stopped;
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await exited;
  }
}
function progress(root: string) {
  return JSON.parse(
    readFileSync(
      join(root, "control-private/ops-agent/retention-families/slot-0/progress.json"),
      "utf8",
    ),
  ) as {
    terminalAt: number;
    executions: Record<
      string,
      { known: boolean; terminalAt: number; terminalDigest: string; journalContained: boolean }
    >;
  };
}
const cases = [
  { boundary: "terminal", outcome: "success", known: true },
  { boundary: "digest", outcome: "success", known: true },
  { boundary: "terminal", outcome: "not-started", known: true },
  { boundary: "digest", outcome: "not-started", known: true },
  { boundary: "terminal", outcome: "unknown", known: false },
  { boundary: "terminal", outcome: "configuration", known: true },
  { boundary: "terminal", outcome: "success", known: false, tamper: "missing-proof" },
  { boundary: "terminal", outcome: "success", known: false, tamper: "mismatched-journal" },
  { boundary: "terminal", outcome: "success", known: false, tamper: "admission-time" },
] as const;
it.each(
  cases.map((scenario) => ({
    ...scenario,
    label: "tamper" in scenario ? scenario.tamper : "original",
  })),
)(
  "repairs only proven terminal retention across actual restart ($boundary/$outcome/$label)",
  async (scenario) => {
    const { boundary, outcome, known } = scenario;
    const root = mkdtempSync(join(tmpdir(), "omx-terminal-restart-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await c.provisionControlInstallation(root);
    let app: ReturnType<typeof buildOpsAgentServer> | undefined;
    let installation: c.ControlInstallation | undefined;
    const dispatch = vi.fn(async () => {
      throw Error("Restart must never dispatch");
    });
    try {
      const stopped = await interrupt(root, boundary, outcome),
        original = stopped.job;
      if ("tamper" in scenario) {
        if (scenario.tamper === "missing-proof")
          rmSync(join(root, `control-private/ops-agent/effects/${original.operationKey}.json`));
        else if (scenario.tamper === "admission-time") {
          if (original.admittedAt === undefined) throw Error("Missing fixture admission timestamp");
          original.admittedAt += 1;
          original.submittedAt = new Date(original.admittedAt).toISOString();
          writeFileSync(
            join(root, "data/ops-agent/jobs-v1.json"),
            JSON.stringify({ version: 2, jobs: [original] }),
          );
        } else {
          original.result = { backupId: "different-result" };
          const changedJournal = await openOpsJobJournal(join(root, "data/ops-agent/jobs-v1.json"));
          await changedJournal.replace([original]);
        }
      }
      expect(
        existsSync(
          join(root, "control-private/ops-agent/retention-families/slot-0/.family-writer"),
        ),
      ).toBe(false);
      expect(
        existsSync(join(root, `control-private/ops-agent/effect-writers/${original.operationKey}`)),
      ).toBe(false);
      if (!original.terminalAt) throw Error("Missing actual terminal journal timestamp");
      const initial = progress(root);
      expect(Object.values(initial.executions)[0]?.journalContained).toBe(false);
      const originalEligibility = initial.terminalAt;
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.parse(original.terminalAt) + 71 * 3600_000);
      const start = async () => {
        installation = c.openControlInstallation({
          infraDir: root,
          role: "ops-agent",
          serviceIds: ["motis"],
        });
        const journal = await openOpsJobJournal(join(root, "data/ops-agent/jobs-v1.json"));
        const terminalClaimCleanup =
          "revisionId" in original.operation
            ? await initializeTerminalClaimCleanup(join(root, "trusted-config"), {
                allowedUids: [process.getuid?.() ?? -1],
                expectedGid: process.getgid?.() ?? -1,
                token: Buffer.alloc(32, 7).toString("base64url"),
                journalRecords: journal.records(),
              })
            : undefined;
        app = buildOpsAgentServer({
          terminalClaimCleanup,
          tokens: {
            api: Buffer.alloc(32, 7).toString("base64url"),
            "data-manager": "b".repeat(32),
          },
          controlInstallation: installation,
          journal,
          dispatch,
          now: () => new Date(Date.now()),
          resourcePolicy: { allowBackup: () => true },
        });
        await app.ready();
        expect(journal.records()).toEqual([original]);
        return journal;
      };
      if ("revisionId" in original.operation) {
        installation = c.openControlInstallation({
          infraDir: root,
          role: "ops-agent",
          serviceIds: ["motis"],
        });
        const unproved = await openOpsJobJournal(join(root, "data/ops-agent/jobs-v1.json"));
        const claimed = join(root, `trusted-config/.claimed/${original.operation.revisionId}.json`);
        expect(existsSync(claimed)).toBe(true);
        app = buildOpsAgentServer({
          tokens: {
            api: Buffer.alloc(32, 7).toString("base64url"),
            "data-manager": "b".repeat(32),
          },
          controlInstallation: installation,
          journal: unproved,
          dispatch,
          terminalClaimCleanup: Object.freeze(
            {},
          ) as import("./trusted-config-source").VerifiedTerminalClaimCleanup,
        });
        await app.ready();
        expect(Object.values(progress(root).executions)[0]?.journalContained).toBe(false);
        expect(existsSync(claimed)).toBe(true);
        await app.close();
        app = undefined;
        c.closeControlInstallation(installation);
        installation = undefined;
      }
      let journal = await start();
      if ("revisionId" in original.operation)
        expect(
          existsSync(join(root, `trusted-config/.claimed/${original.operation.revisionId}.json`)),
        ).toBe(false);
      const get = async () => {
        if (!app) throw Error("Missing restarted server");
        const response = await app.inject({
          url: `/v1/operations/${original.operationId}`,
          headers: {
            authorization: `Bearer ${Buffer.alloc(32, 7).toString("base64url")}`,
            "x-ops-protocol-version": "2",
          },
        });
        expect(response.statusCode).toBe(200);
        return parseOpsJobStatus(response.json().result);
      };
      const status = await get();
      expect(status).toMatchObject({
        operationId: original.operationId,
        operationKey: original.operationKey,
        admittedAt: original.admittedAt,
        deadlineAt: original.deadlineAt,
        fingerprint: original.fingerprint,
        state: original.state,
        updatedAt: original.updatedAt,
      });
      const digest = controlTerminalReceiptDigest(status);
      if (!("tamper" in scenario))
        expect(Object.values(initial.executions)[0]?.terminalDigest === digest).toBe(
          boundary === "digest",
        );
      const ack = {
        kind: "controlRetention.acknowledge",
        originRootKey: original.operationKey,
        operationKey: original.operationKey,
        fingerprint: original.fingerprint,
        terminalDigest: digest,
        proof: signApiRetentionProof(Buffer.alloc(32, 7).toString("base64url"), {
          version: 1,
          apiJobId: stopped.apiJobId,
          originalApiOwnerVersion: 1,
          attemptId: stopped.attemptId,
          checkpointOwnerVersion: 1,
          terminalCopyId: randomUUID(),
          operationKey: original.operationKey,
          fingerprint: original.fingerprint,
          terminalDigest: digest,
        }),
      };
      const acknowledge = async () => {
        if (!app) throw Error("Missing restarted server");
        return app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: {
            authorization: `Bearer ${Buffer.alloc(32, 7).toString("base64url")}`,
            "x-ops-protocol-version": "2",
          },
          payload: {
            version: 2,
            requestId: `ops1_${randomUUID().replaceAll("-", "")}`,
            operationKey: "opk1_ackrequest123456",
            issuedAt: new Date(Date.now()).toISOString(),
            expiresAt: new Date(Date.now() + 10000).toISOString(),
            operation: ack,
          },
        });
      };
      if (known) {
        expect((await acknowledge()).statusCode).toBe(200);
        const repaired = progress(root);
        expect(Object.values(repaired.executions)[0]).toMatchObject({
          known: true,
          terminalDigest: digest,
          journalContained: true,
        });
        expect(repaired.terminalAt).toBeLessThanOrEqual(
          Math.max(originalEligibility, Date.parse(original.terminalAt)),
        );
        await app?.close();
        app = undefined;
        if (installation) c.closeControlInstallation(installation);
        installation = undefined;
        now.mockReturnValue(Date.parse(original.terminalAt) + 71.5 * 3600_000);
        journal = await start();
        expect(await get()).toEqual(status);
        expect(progress(root)).toEqual(repaired);
        expect((await acknowledge()).statusCode).toBe(200);
        now.mockReturnValue(
          Math.max(originalEligibility, Date.parse(original.terminalAt)) + 73 * 3600_000,
        );
        if (!installation) throw Error("Missing reopened installation");
        expect(await c.reconcileControlRetention(installation, { maxFamilies: 1 })).toEqual({
          retired: 1,
          pending: 0,
        });
        expect(journal.records()).toHaveLength(0);
        expect(existsSync(join(root, "control-private/ops-agent/retention-families/slot-0"))).toBe(
          false,
        );
      } else {
        expect((await acknowledge()).statusCode).toBe(409);
        expect(Object.values(progress(root).executions)[0]?.journalContained).toBe(false);
        now.mockReturnValue(Date.parse(original.terminalAt) + 96 * 3600_000);
        if (!installation) throw Error("Missing reopened installation");
        expect(await c.reconcileControlRetention(installation, { maxFamilies: 1 })).toEqual({
          retired: 0,
          pending: 1,
        });
        expect(journal.records()).toEqual([original]);
      }
      expect(dispatch).not.toHaveBeenCalled();
      const effects = join(root, "effect-calls");
      expect(
        existsSync(effects) ? readFileSync(effects, "utf8").split("\n").filter(Boolean).length : 0,
      ).toBe(outcome === "not-started" ? 0 : 1);
    } finally {
      vi.restoreAllMocks();
      await app?.close();
      if (installation) c.closeControlInstallation(installation);
      rmSync(root, { recursive: true, force: true });
    }
  },
  90000,
);

it("repairs a borrowed terminal worker after the actual canonical-digest restart boundary without replay or releasing its parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-borrowed-terminal-restart-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await c.provisionControlInstallation(root);
  const dm = c.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["motis"],
  });
  let installation: c.ControlInstallation | undefined,
    app: ReturnType<typeof buildOpsAgentServer> | undefined;
  const dispatch = vi.fn(async () => {
    throw Error("Restart must never dispatch");
  });
  try {
    const deadlineAt = Date.now() + 120000,
      operation = { kind: "transit-sync" };
    const operationFingerprint = createHash("sha256")
      .update(JSON.stringify(operation))
      .digest("hex");
    const owner: ExecutionRef = {
      executor: "data-manager",
      principal: "data-manager",
      executionId: randomUUID(),
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
      deadlineAt,
    };
    const childFingerprint = opsOperationFingerprint({ kind: "motis.primary.stop" });
    const execution: ExecutionRef = {
      executor: "ops-agent",
      principal: "data-manager",
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: c.controlChildOperationKey(owner.operationKey, "stop-primary", 0),
      operationFingerprint: childFingerprint,
      fingerprint: executionFingerprint({
        kind: "motis.primary.stop",
        operationFingerprint: childFingerprint,
        deadlineAt,
        parent: c.retainedControlParent(owner),
      }),
      deadlineAt,
    };
    const plan = {
      phase: "stop-primary" as const,
      ordinal: 0,
      kind: "motis.primary.stop",
      execution,
      serviceIds: ["motis"],
      recipient: "ops-agent" as const,
    };
    const authority = c.retainAdmittedControlExecution(dm, {
      execution: owner,
      operation,
      kind: operation.kind,
      admittedAt: deadlineAt - 120000,
      requestedDeadlineAt: deadlineAt,
      serviceIds: ["motis"],
      plan: [plan],
    });
    const lease = await c.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["motis"],
      owner: authority,
    });
    const peer = c.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis"],
    });
    const assertion = await c.delegateArtifactTargetLease(lease, {
      ...plan,
      childPublicKey: peer.publicKey,
    });
    c.closeControlInstallation(peer);
    const stopped = await interrupt(root, "digest", "success", { assertion, execution });
    const initial = progress(root);
    expect(Object.values(initial.executions)[0]?.journalContained).toBe(false);
    installation = c.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis"],
    });
    const journal = await openOpsJobJournal(join(root, "data/ops-agent/jobs-v1.json"));
    app = buildOpsAgentServer({
      tokens: { api: Buffer.alloc(32, 7).toString("base64url"), "data-manager": "b".repeat(32) },
      controlInstallation: installation,
      journal,
      dispatch,
      resourcePolicy: { allowGlobal: () => true },
    });
    await app.ready();
    expect(journal.records()).toEqual([stopped.job]);
    expect(Object.values(progress(root).executions)[0]).toMatchObject({
      journalContained: true,
      known: true,
    });
    expect(progress(root).terminalAt).toBe(initial.terminalAt);
    expect(existsSync(join(root, "data/.admin-target-control/locks/motis"))).toBe(true);
    c.retainControlEffectReceipt(authority, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    });
    await c.settleArtifactTargetLeaseChild(lease, c.verifyControlEffectSettlement(dm, owner));
    await c.releaseArtifactTargetLease(lease);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 96 * 3600_000);
    let retired = 0;
    for (let n = 0; n < 12 && retired < 2; n++) {
      retired += (await c.reconcileControlRetention(installation, { maxFamilies: 1 })).retired;
      retired += (await c.reconcileControlRetention(dm, { maxFamilies: 1 })).retired;
    }
    expect(retired).toBe(2);
    expect(journal.records()).toHaveLength(0);
    expect(readFileSync(join(root, "effect-calls"), "utf8")).toBe("effect\n");
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await app?.close();
    if (installation) c.closeControlInstallation(installation);
    c.closeControlInstallation(dm);
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
