import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import * as c from "@openmapx/core/build-artifacts";
import {
  controlTerminalReceiptDigest,
  createControlRootOperationKey,
  type ExecutionRef,
  type OpsJobStatus,
  type OpsOperation,
  opsOperationFingerprint,
  sealTrustedConfigurationSnapshot,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { AnchoredDirectory } from "../../../../packages/core/src/build-artifacts/filesystem";
import { configurationSource } from "../__fixtures__/configuration-source";
import { openOpsJobJournal, type PersistedOpsJob } from "../journal";
import { createRegistryResourceClaimer } from "../policy";
import { createUnavailableRuntime } from "../runtime";
import { buildOpsAgentServer } from "../server";
import { installTrustedConfigurationRuntime } from "../trusted-config-runtime";
import {
  createFileTrustedOpsDataSource,
  initializeTrustedSnapshotDirectory,
} from "../trusted-config-source";

let inputText = "";
for await (const chunk of process.stdin) inputText += chunk;
const input = JSON.parse(inputText) as {
  root: string;
  boundary: "terminal" | "digest";
  outcome: "success" | "unknown" | "not-started" | "configuration";
  borrowed?: { assertion: string; execution: ExecutionRef };
};
const token = Buffer.alloc(32, 7).toString("base64url"),
  notAfter = input.borrowed?.execution.deadlineAt ?? Date.now() + 120000;
const key =
  input.borrowed?.execution.operationKey ??
  createControlRootOperationKey({ notAfter, nonce: randomBytes(16) });
let operation: OpsOperation = input.borrowed
  ? { kind: "motis.primary.stop" }
  : { kind: "backup.delete", backupId: "daily" };
let resourceClaimer: ReturnType<typeof createRegistryResourceClaimer> | undefined;
if (input.outcome === "configuration") {
  const sourceRuntime = createUnavailableRuntime();
  installTrustedConfigurationRuntime(sourceRuntime, {
    infraDir: input.root,
    env: {},
    integrationSchemas: new Map(),
    services: [
      {
        manifest: {
          id: "motis",
          name: "motis",
          version: "1.0.0",
          quality: "built-in",
          container: { image: "example/motis", tag: "1" },
        },
        directory: join(input.root, "services/motis"),
        enabled: true,
        isBuiltIn: true,
      },
    ],
  });
  const source = await configurationSource(sourceRuntime, input.root);
  const directory = join(input.root, "trusted-config");
  mkdirSync(directory, { mode: 0o700 });
  const policy = {
    allowedUids: [process.getuid?.() ?? -1],
    expectedGid: process.getgid?.() ?? -1,
    token,
  };
  await initializeTrustedSnapshotDirectory(directory, policy);
  const snapshot = sealTrustedConfigurationSnapshot({
    role: "api",
    operationKey: key,
    token,
    issuedAtMs: Date.now(),
    nonce: "nonce_0123456789abcdef",
    operationForRevision: (revisionId) => ({
      ...source,
      kind: "stack.render",
      revisionId,
      expectedCurrentRevisionId: null,
    }),
    payload: {
      domain: "maps.example.test",
      selectedRoots: ["motis"],
      serviceConfigs: [{ serviceId: "motis", values: {} }],
      integrationConfigs: [],
      serviceSecrets: [],
    },
  });
  operation = snapshot.operation;
  writeFileSync(join(directory, `${snapshot.revisionId}.json`), snapshot.bytes, { mode: 0o600 });
  resourceClaimer = createRegistryResourceClaimer({
    serviceIds: ["motis"],
    integrationIds: [],
    trustedData: createFileTrustedOpsDataSource({ directory, ...policy }),
  });
}
const apiJobId = randomUUID(),
  attemptId = randomUUID();
const installation = c.openControlInstallation({
  infraDir: input.root,
  role: "ops-agent",
  serviceIds: ["motis"],
});
const journal = await openOpsJobJournal(coreServices.agentStatePaths(input.root).journal);
let terminal: PersistedOpsJob | undefined;
function wire(job: PersistedOpsJob): OpsJobStatus {
  return {
    version: 2,
    operationId: job.operationId,
    operationKey: job.operationKey,
    kind: job.operation.kind,
    resourceId: job.resourceId,
    state: job.state,
    submittedAt: job.submittedAt,
    updatedAt: job.updatedAt,
    admittedAt: job.admittedAt,
    deadlineAt: job.deadlineAt,
    fingerprint: job.fingerprint,
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.errorClass === undefined ? {} : { errorClass: job.errorClass }),
    ...(job.failureResult === undefined ? {} : { failureResult: job.failureResult }),
    ...(job.terminationRequestedAt === undefined
      ? {}
      : { terminationRequestedAt: job.terminationRequestedAt }),
  } as OpsJobStatus;
}
function stop(job: PersistedOpsJob): never {
  writeSync(1, `${JSON.stringify({ job, apiJobId, attemptId })}\n`);
  process.kill(process.pid, "SIGSTOP");
  throw Error("Stopped fixture resumed unexpectedly");
}
// This is an actual pre-publication filesystem failure, not a startup-helper mock.
const write = AnchoredDirectory.prototype.write;
AnchoredDirectory.prototype.write = function (...args) {
  if (input.outcome === "not-started" && args[0] === `${key}.json`) {
    const value = JSON.parse(args[1].toString());
    if (value?.execution && value.receiptDigest) throw Error("effect intent publication failed");
  }
  return write.apply(this, args);
};
const remove = AnchoredDirectory.prototype.removeDirectory;
AnchoredDirectory.prototype.removeDirectory = function (...args) {
  const result = remove.apply(this, args);
  // Stop after the real canonical-digest transaction AND guard removal. No
  // unknown metadata writer is left for startup to steal.
  if (
    input.boundary === "digest" &&
    terminal &&
    [".family-writer", key].includes(args[0]) &&
    !existsSync(join(input.root, `control-private/ops-agent/effect-writers/${key}`)) &&
    !existsSync(
      join(input.root, "control-private/ops-agent/retention-families/slot-0/.family-writer"),
    )
  ) {
    const progress = JSON.parse(
      readFileSync(
        join(input.root, "control-private/ops-agent/retention-families/slot-0/progress.json"),
        "utf8",
      ),
    );
    const facts = Object.values(progress.executions) as Array<{
      execution: { executionId: string };
      terminalDigest?: string;
      journalContained?: boolean;
    }>;
    if (
      facts.some(
        (f) =>
          f.execution.executionId === terminal?.operationId &&
          f.terminalDigest === controlTerminalReceiptDigest(wire(terminal)) &&
          !f.journalContained,
      )
    )
      stop(terminal);
  }
  return result;
};
const replace = journal.replace;
journal.replace = async (records) => {
  await replace(records);
  terminal = records.find((job) => ["succeeded", "failed", "timed_out"].includes(job.state));
  if (!terminal) return;
  if (input.outcome === "not-started") {
    if (
      terminal.admittedAt === undefined ||
      terminal.deadlineAt === undefined ||
      !terminal.operationFingerprint
    )
      throw Error("Missing exact admission");
    const execution = {
      executor: "ops-agent" as const,
      principal: "api" as const,
      executionId: terminal.operationId,
      operationKey: terminal.operationKey,
      operationFingerprint: terminal.operationFingerprint,
      fingerprint: terminal.fingerprint,
      deadlineAt: terminal.deadlineAt,
    };
    const authority = c.restoreAdmittedControlExecution(installation, execution);
    // The fixed executor signs actual never-started evidence only after the
    // failed intent write and joined failure handler; no application IO ran.
    c.retainControlEffectReceipt(authority, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    });
  }
  if (input.boundary === "terminal") stop(terminal);
};
const app = buildOpsAgentServer({
  tokens: { api: token, "data-manager": "b".repeat(32) },
  controlInstallation: installation,
  journal,
  resourcePolicy: { allowBackup: () => true, allowGlobal: () => true, allowService: () => true },
  resourceClaimer,
  dispatch: async () => {
    appendFileSync(join(input.root, "effect-calls"), "effect\n", { mode: 0o600 });
    if (input.outcome === "unknown") throw Error("uncontained application failure");
    if (input.borrowed) return { changed: true, state: "stopped" };
    return "revisionId" in operation
      ? {
          outcome: "committed",
          revisionId: operation.revisionId,
          enabledServiceIds: ["motis"],
          followUp: "complete",
          cleanupFailed: false,
        }
      : { backupId: "daily" };
  },
});
const fields = {
  version: 1,
  apiJobId,
  apiOwnerVersion: 1,
  parentOperationKey: "opk1_parentabcdefghijkl",
  parentFingerprint: "b".repeat(64),
  parentDeadlineAt: notAfter,
  childOperationKey: key,
  childOperationFingerprint: opsOperationFingerprint(operation),
  requestedDeadlineAt: notAfter,
  attemptId,
};
const payload = Buffer.from(JSON.stringify(fields)).toString("base64url");
const parent = `${payload}.${createHmac("sha256", token).update("openmapx-api-job-parent-v1\0").update(payload).digest("base64url")}`;
const admitted = await app.inject({
  method: "POST",
  url: "/v1/operations",
  headers: {
    authorization: `Bearer ${input.borrowed ? "b".repeat(32) : token}`,
    "x-ops-protocol-version": "2",
    ...(input.borrowed
      ? { "x-openmapx-control-delegation": input.borrowed.assertion }
      : { "x-openmapx-parent-execution": parent }),
  },
  payload: {
    version: 2,
    requestId: `ops1_${randomUUID().replaceAll("-", "")}`,
    operationKey: key,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    operation,
    execution: { requestedDeadlineAt: notAfter },
  },
});
if (admitted.statusCode !== 202) throw Error(`Fixture admission failed ${admitted.body}`);
