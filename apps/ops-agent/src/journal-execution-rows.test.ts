import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireArtifactTargetLease,
  beginControlEffect,
  CONTROL_PRUNE_AFTER_MS,
  type ControlInstallation,
  closeArtifactTargetLeaseHandle,
  closeControlInstallation,
  executionEffectStarted,
  keepExecutionRowsIn,
  openControlInstallation,
  provisionControlDirectories,
  pruneControlRecords,
  releaseArtifactTargetLease,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  settleArtifactTargetLeaseChild,
  verifyControlEffectSettlement,
} from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { afterEach, beforeEach, expect, it } from "vitest";
import { journalFileRows } from "../../../packages/core/src/build-artifacts/execution-rows";
import { executionFor, type JobRecord, JobTable } from "./job-table";
import { openOpsJobJournal } from "./journal";
import { persistedJob } from "./test-fixtures/persisted-job";

let root: string;
let journalPath: string;
let installation: ControlInstallation;
let table: JobTable;

const settlement = {
  observe: async () => undefined,
  settle: async (input: { state: JobRecord["state"]; updates: object }) => ({
    state: input.state,
    updates: input.updates,
  }),
  cancel: async () => {},
  dropsFailureResultOnSuccess: () => false,
};

/** The agent as it starts: its journal, its job table and its installation. */
async function start() {
  table = new JobTable({
    journal: await openOpsJobJournal(journalPath),
    now: () => new Date(),
    maxJobEntries: 16,
    jobRetentionMs: 72 * 3600_000,
    controlRoots: true,
    settlement,
  });
  installation = openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["osrm"],
  });
  keepExecutionRowsIn(installation, table.executionRows());
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-journal-rows-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlDirectories(root);
  journalPath = join(root, "state/ops-agent/jobs-v1.json");
  await start();
});
afterEach(() => {
  closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});

const operation = { kind: "service.build", serviceId: "osrm" } as const;

/** Admits an operation the way the agent does: its journal row, then its execution. */
async function admit() {
  const deadline = Date.now() + 60_000;
  const job: JobRecord = {
    ...persistedJob(operation, {
      operationId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
      requestedDeadlineAt: deadline,
      submittedAt: new Date().toISOString(),
    }),
    terminalAt: undefined,
    cursor: 0,
    events: [],
    eventBytes: 0,
    eventsTruncated: false,
  };
  await table.persist({ job, with: job });
  table.add(job);
  const input = {
    execution: executionFor(job),
    operation,
    kind: operation.kind,
    admittedAt: job.admittedAt,
    requestedDeadlineAt: deadline,
    serviceIds: ["osrm"],
  };
  return { job, input, handle: await retainAdmittedControlExecution(installation, input) };
}

/** The journal as it is on disk. */
function journalRow(key: string) {
  const file = JSON.parse(readFileSync(journalPath, "utf8")) as {
    jobs: { operationKey: string; execution?: { progress: Record<string, unknown> } }[];
  };
  return file.jobs.find((job) => job.operationKey === key);
}

/** Records the job's terminal state the way a transition does. */
async function finish(job: JobRecord, state: "succeeded" | "failed") {
  Object.assign(job, {
    state,
    terminalAt: Date.now(),
    updatedAt: new Date().toISOString(),
    ...(state === "succeeded"
      ? { result: { built: true, serviceId: "osrm" } }
      : { errorClass: "runtime" as const }),
  });
  await table.persist();
}

it("keeps an operation's execution on its journal row, durable before the effect", async () => {
  const { job, handle } = await admit();
  expect(journalRow(job.operationKey)?.execution?.progress).toMatchObject({
    phase: "held",
    effectStartedAt: null,
    settlement: null,
  });
  expect(existsSync(join(root, "state/ops-agent/control/executions"))).toBe(false);
  await beginControlEffect(handle);
  // Recorded before the effect: the journal on disk already says it started.
  expect(journalRow(job.operationKey)?.execution?.progress.effectStartedAt).toEqual(
    expect.any(Number),
  );
  closeControlInstallation(installation);
  await start();
  expect(
    await executionEffectStarted(
      await restoreAdmittedControlExecution(installation, executionFor(job)),
    ),
  ).toBe(true);
});

it("refuses the same key with a different admission", async () => {
  const { job, input } = await admit();
  await expect(retainAdmittedControlExecution(installation, input)).resolves.toMatchObject({
    execution: executionFor(job),
  });
  const rows = table.executionRows(),
    row = await rows.read(job.operationKey);
  if (!row) throw Error("Row missing");
  await expect(
    rows.admit({ ...row, admission: { ...row.admission, serviceIds: ["motis", "osrm"] } }),
  ).rejects.toThrow(/Conflicting/);
});

it("keeps an attempted operation interrupted by a restart for recovery, with its row", async () => {
  const { job, handle } = await admit();
  await beginControlEffect(handle);
  job.state = "running";
  await table.persist();
  closeControlInstallation(installation);
  await start();
  const restored = table.byId.get(job.operationId);
  expect(restored).toMatchObject({ state: "failed", errorClass: "recovery_required" });
  // Nothing re-dispatches it, and the prune is not offered its row.
  expect((await table.executionRows().keys(16)).keys).toEqual([]);
  expect(
    await pruneControlRecords(installation, { now: job.deadlineAt + 30 * 24 * 3600_000 }),
  ).toEqual([]);
  expect(journalRow(job.operationKey)?.execution?.progress.effectStartedAt).toEqual(
    expect.any(Number),
  );
});

it("keeps an unknown outcome and its lease until the lease is resolved", async () => {
  const { job, handle } = await admit();
  const lease = await acquireArtifactTargetLease({ serviceIds: ["osrm"], owner: handle });
  try {
    await beginControlEffect(handle);
    await retainControlEffectReceipt(handle, {
      outcome: "unknown",
      publication: "unknown",
      receipt: { kind: "unresolved" },
    });
    await finish(job, "failed");
    await settleArtifactTargetLeaseChild(
      lease,
      await verifyControlEffectSettlement(installation, handle.execution),
    );
    // Unknown never releases.
    await expect(releaseArtifactTargetLease(lease)).rejects.toThrow();
    expect(
      await pruneControlRecords(installation, { now: job.deadlineAt + 30 * 24 * 3600_000 }),
    ).toEqual([]);
    expect(journalRow(job.operationKey)?.execution).toBeDefined();
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
});

it("prunes a settled row once its key expired, 72 hours passed and its lease was released", async () => {
  const { job, handle } = await admit();
  const lease = await acquireArtifactTargetLease({ serviceIds: ["osrm"], owner: handle });
  try {
    await retainControlEffectReceipt(handle, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    });
    await finish(job, "failed");
    const later = job.deadlineAt + CONTROL_PRUNE_AFTER_MS + 60_000;
    expect(await pruneControlRecords(installation, { now: Date.now() })).toEqual([]);
    // Its lease is still held: an attempted child may not have settled.
    expect(await pruneControlRecords(installation, { now: later })).toEqual([]);
    await settleArtifactTargetLeaseChild(
      lease,
      await verifyControlEffectSettlement(installation, handle.execution),
    );
    await releaseArtifactTargetLease(lease);
    expect(await pruneControlRecords(installation, { now: later })).toEqual([job.operationKey]);
    expect(journalRow(job.operationKey)).toBeUndefined();
    expect(table.byId.has(job.operationId)).toBe(false);
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
});

it("lets another process read the agent's rows from its journal, never write them", async () => {
  const { job } = await admit();
  const rows = journalFileRows(root);
  expect(rows.owns(job.operationKey)).toBe(true);
  expect((await rows.read(job.operationKey))?.admission.execution).toEqual(executionFor(job));
  await expect(rows.update(job.operationKey, () => undefined)).rejects.toThrow(/Only the agent/);
});
