import { createHash, randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type ControlAdoption, controlAdoptionSchema } from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  type HistoricalServicePullOperation,
  historicalServicePullOperationSchema,
  historicalServicePullResultSchema,
  OPS_KIND_POLICIES,
  OPS_PUBLIC_ERROR_MESSAGES,
  type OpsErrorClass,
  type OpsFailureResult,
  type OpsJobState,
  type OpsOperation,
  type OpsRole,
  opsFailureResultSchema,
  opsOperationFingerprint,
  opsOperationSchema,
  opsResourceId,
  type ProcessDiagnostics,
  parseBoundedOpsResult,
  processDiagnosticsSchema,
  type RetainedExecutionAdmission,
  validateRetainedConfigurationMaintenanceRecoveryControl,
  validateRetainedExecutionAdmission,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";

const OPS_JOB_JOURNAL_MAX_ENTRIES = 256;
export const OPS_JOB_JOURNAL_MAX_BYTES = 24 * 1024 * 1024;
export const OPS_JOB_JOURNAL_MAX_ORPHANS = 8;
const OPERATION_ID = /^job1_[A-Za-z0-9_-]{16,64}$/;
const OPERATION_KEY = /^opk1_[A-Za-z0-9_-]{16,64}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const JOB_STATES = new Set<OpsJobState>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "termination_pending",
  "timed_out",
]);
const ERROR_CLASSES = new Set<OpsErrorClass>(
  Object.keys(OPS_PUBLIC_ERROR_MESSAGES) as OpsErrorClass[],
);

export interface PersistedOpsJob {
  controlAdoption?: ControlAdoption;
  executionVersion?: 2;
  requestVersion?: 1 | 2;
  admittedAt?: number;
  deadlineAt?: number;
  operationFingerprint?: string;
  requestedDeadlineAt?: number;
  deploymentBudgetMs?: number;
  parent?: RetainedExecutionAdmission["parent"];
  diagnostics?: ProcessDiagnostics;
  failureResult?: OpsFailureResult;
  /** Private checkpoint, never a terminal outcome or authority. */
  progressResult?: OpsFailureResult;
  role: OpsRole;
  operation: OpsOperation;
  operationId: string;
  operationKey: string;
  fingerprint: string;
  resourceId: string;
  state: OpsJobState;
  submittedAt: string;
  updatedAt: string;
  result?: unknown;
  errorClass?: OpsErrorClass;
  terminalAt?: string;
  // Durable proof that a cancellation request moved this job into
  // `termination_pending`, retained through its terminal state.
  terminationRequestedAt?: string;
}

export interface OpsJobJournal {
  records(): readonly PersistedOpsJob[];
  /** Historical pulls are an immutable observation view, never worker input. */
  historicalPullRecords?(): readonly HistoricalPullJob[];
  replace(records: readonly PersistedOpsJob[]): Promise<void>;
}
const productionJournalIndexes = new WeakMap<
  OpsJobJournal,
  {
    path: string;
    read(): readonly PersistedOpsJob[];
  }
>();
/** A bounded locator view of this actual journal, never source authority. */
export function readProductionCoordinatorJournalIndex(journal: OpsJobJournal, dataRoot: string) {
  const owned = productionJournalIndexes.get(journal);
  if (
    !owned ||
    owned.path !== coreServices.agentStatePaths(dirname(realpathSync(dataRoot))).journal
  )
    throw Error("Actual fixed ops-agent journal required");
  const records = owned.read();
  if (records.length > OPS_JOB_JOURNAL_MAX_ENTRIES) throw Error("Ops journal index limit");
  return records;
}
export interface HistoricalPullJob extends Omit<PersistedOpsJob, "operation"> {
  operation: HistoricalServicePullOperation;
}
type RetainedOpsJob = PersistedOpsJob | HistoricalPullJob;
function historical(job: RetainedOpsJob): job is HistoricalPullJob {
  return (
    job.operation.kind === "service.pull" && !("expectedConfigurationRevisionId" in job.operation)
  );
}

export interface OpenOpsJobJournalOptions {
  now?: () => Date;
  maxEntries?: number;
  maxBytes?: number;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function iso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function parseJob(value: unknown): RetainedOpsJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const raw = value as Record<string, unknown>;
  if (
    !exactKeys(raw, [
      "executionVersion",
      "controlAdoption",
      "requestVersion",
      "admittedAt",
      "deadlineAt",
      "operationFingerprint",
      "requestedDeadlineAt",
      "deploymentBudgetMs",
      "parent",
      "diagnostics",
      "failureResult",
      "progressResult",
      "role",
      "operation",
      "operationId",
      "operationKey",
      "fingerprint",
      "resourceId",
      "state",
      "submittedAt",
      "updatedAt",
      "result",
      "errorClass",
      "terminalAt",
      "terminationRequestedAt",
    ]) ||
    (raw.role !== "api" && raw.role !== "data-manager") ||
    typeof raw.operationId !== "string" ||
    !OPERATION_ID.test(raw.operationId) ||
    typeof raw.operationKey !== "string" ||
    !OPERATION_KEY.test(raw.operationKey) ||
    typeof raw.fingerprint !== "string" ||
    !FINGERPRINT.test(raw.fingerprint) ||
    typeof raw.resourceId !== "string" ||
    typeof raw.state !== "string" ||
    !JOB_STATES.has(raw.state as OpsJobState) ||
    !iso(raw.submittedAt) ||
    !iso(raw.updatedAt) ||
    (raw.terminalAt !== undefined && !iso(raw.terminalAt)) ||
    (raw.terminationRequestedAt !== undefined && !iso(raw.terminationRequestedAt)) ||
    (raw.errorClass !== undefined &&
      (typeof raw.errorClass !== "string" || !ERROR_CLASSES.has(raw.errorClass as OpsErrorClass)))
  ) {
    throw new Error("invalid");
  }
  if (raw.controlAdoption !== undefined) {
    controlAdoptionSchema.parse(raw.controlAdoption);
    if (raw.executionVersion !== 2) throw Error("invalid control adoption");
  }
  const legacy = historicalServicePullOperationSchema.safeParse(raw.operation),
    operation = legacy.success ? legacy.data : opsOperationSchema.parse(raw.operation),
    bodyFingerprint = legacy.success
      ? createHash("sha256").update(canonicalJson(operation)).digest("hex")
      : opsOperationFingerprint(opsOperationSchema.parse(operation));
  if (
    bodyFingerprint !== (raw.executionVersion === 2 ? raw.operationFingerprint : raw.fingerprint) ||
    (legacy.success
      ? legacy.data.serviceId
      : opsResourceId(opsOperationSchema.parse(operation))) !== raw.resourceId
  ) {
    throw new Error("invalid");
  }
  if (raw.executionVersion === 2) {
    if (
      operation.kind === "configurationMaintenance.settle" ||
      (operation.kind === "configurationMaintenance.decide" && operation.decision === "abandon")
    )
      validateRetainedConfigurationMaintenanceRecoveryControl(
        operation,
        raw as unknown as RetainedExecutionAdmission,
      );
    else
      validateRetainedExecutionAdmission(
        operation.kind,
        raw as unknown as RetainedExecutionAdmission,
      );
    if (raw.requestVersion !== undefined && raw.requestVersion !== 1 && raw.requestVersion !== 2)
      throw new Error("invalid request version");
    if (raw.admittedAt !== Date.parse(raw.submittedAt as string)) throw new Error("invalid");
  } else if (
    [
      "executionVersion",
      "requestVersion",
      "admittedAt",
      "deadlineAt",
      "operationFingerprint",
      "requestedDeadlineAt",
      "deploymentBudgetMs",
      "parent",
    ].some((key) => raw[key] !== undefined)
  )
    throw new Error("invalid");
  if (raw.diagnostics !== undefined) processDiagnosticsSchema.parse(raw.diagnostics);
  if (raw.progressResult !== undefined) {
    const progress = opsFailureResultSchema.parse(raw.progressResult);
    const allowed =
      operation.kind === "data.update"
        ? "dataWorkflow"
        : operation.kind === "services.buildAll"
          ? "serviceBatch"
          : null;
    if (
      raw.executionVersion !== 2 ||
      !allowed ||
      !["queued", "running", "termination_pending"].includes(raw.state as string) ||
      Object.keys(progress).some((key) => key !== allowed) ||
      Buffer.byteLength(JSON.stringify(progress)) > OPS_KIND_POLICIES[operation.kind].maxResultBytes
    )
      throw Error("invalid");
  }
  if (raw.failureResult !== undefined) {
    if (!["failed", "timed_out"].includes(raw.state as string)) throw new Error("invalid");
    const result = opsFailureResultSchema.parse(raw.failureResult);
    if (
      Buffer.byteLength(JSON.stringify(result)) > OPS_KIND_POLICIES[operation.kind].maxResultBytes
    )
      throw new Error("invalid");
  }
  const state = raw.state as OpsJobState;
  if (state === "succeeded") {
    if (raw.result === undefined || raw.errorClass !== undefined || raw.terminalAt === undefined)
      throw new Error("invalid");
    if (legacy.success) historicalServicePullResultSchema.parse(raw.result);
    else parseBoundedOpsResult(operation.kind, raw.result);
  } else if (state === "failed" || state === "timed_out") {
    // This finite metadata control can retain an accepted intent without any
    // conclusive completion. Startup rejoins it to the authenticated private
    // owner before lookup; parsing this projection grants no completion/ACK.
    const unresolvedSettle =
      raw.executionVersion === 2 &&
      operation.kind === "configurationMaintenance.settle" &&
      state === "failed" &&
      raw.errorClass === "recovery_required" &&
      raw.failureResult === undefined;
    if (
      raw.result !== undefined ||
      raw.errorClass === undefined ||
      (raw.terminalAt === undefined && !unresolvedSettle)
    )
      throw new Error("invalid");
  } else if (
    raw.result !== undefined ||
    raw.errorClass !== undefined ||
    raw.terminalAt !== undefined
  ) {
    throw new Error("invalid");
  }
  if (raw.progressResult === undefined) delete raw.progressResult;
  return raw as unknown as RetainedOpsJob;
}

function parseFile(bytes: Uint8Array, maxEntries: number): RetainedOpsJob[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const decoded = JSON.parse(text) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid");
  const raw = decoded as Record<string, unknown>;
  if (
    Object.keys(raw).sort().join(",") !== "jobs,version" ||
    (raw.version !== 1 && raw.version !== 2) ||
    !Array.isArray(raw.jobs) ||
    raw.jobs.length > maxEntries
  ) {
    throw new Error("invalid");
  }
  const jobs = raw.jobs.map(parseJob);
  if (raw.version === 1 && jobs.some((job) => job.executionVersion !== undefined))
    throw new Error("invalid journal version");
  const ids = new Set(jobs.map((entry) => entry.operationId));
  const keys = new Set(jobs.map((entry) => `${entry.role}:${entry.operationKey}`));
  if (ids.size !== jobs.length || keys.size !== jobs.length) throw new Error("invalid");
  return jobs;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || (metadata.mode & 0o022) !== 0) {
      throw new Error("invalid journal directory");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareJournalDirectory(path: string): Promise<void> {
  if (basename(path) !== "jobs-v1.json") throw new Error("invalid journal path");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(directory);
  const orphanPattern = /^\.jobs-v1\.json\.[a-f0-9]{24}\.tmp$/;
  const orphans: string[] = [];
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (!orphanPattern.test(entry.name)) continue;
    orphans.push(entry.name);
    if (orphans.length > OPS_JOB_JOURNAL_MAX_ORPHANS) {
      throw new Error("too many journal orphans");
    }
  }
  for (const name of orphans) {
    const orphan = join(directory, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(orphan, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("unsafe journal orphan");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  for (const name of orphans) await unlink(join(directory, name));
  if (orphans.length > 0) await syncDirectory(directory);
}

async function safeRead(path: string, maxBytes: number): Promise<Uint8Array | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > maxBytes) throw new Error();
    const buffer = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw new Error();
    return buffer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Ops job journal is unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Reads the persisted journal without recovering or rewriting it, for a
 * process that must not take ownership of the journal.
 */
export async function readOpsJobJournalSnapshot(path: string): Promise<RetainedOpsJob[]> {
  if (basename(path) !== "jobs-v1.json") throw new Error("Ops job journal is unavailable");
  const bytes = await safeRead(path, OPS_JOB_JOURNAL_MAX_BYTES);
  if (!bytes) return [];
  try {
    return parseFile(bytes, OPS_JOB_JOURNAL_MAX_ENTRIES);
  } catch {
    throw new Error("Ops job journal is unavailable");
  }
}

export async function openOpsJobJournal(
  path: string,
  options: OpenOpsJobJournalOptions = {},
): Promise<OpsJobJournal> {
  const maxEntries = Math.min(
    options.maxEntries ?? OPS_JOB_JOURNAL_MAX_ENTRIES,
    OPS_JOB_JOURNAL_MAX_ENTRIES,
  );
  const maxBytes = Math.min(
    options.maxBytes ?? OPS_JOB_JOURNAL_MAX_BYTES,
    OPS_JOB_JOURNAL_MAX_BYTES,
  );
  if (
    !Number.isInteger(options.maxEntries ?? maxEntries) ||
    (options.maxEntries ?? maxEntries) < 1 ||
    !Number.isInteger(options.maxBytes ?? maxBytes) ||
    (options.maxBytes ?? maxBytes) < 1
  ) {
    throw new Error("Invalid ops job journal limits");
  }
  const now = options.now ?? (() => new Date());
  let current: RetainedOpsJob[] = [];
  try {
    await prepareJournalDirectory(path);
    const bytes = await safeRead(path, maxBytes);
    if (bytes) current = parseFile(bytes, maxEntries);
  } catch {
    throw new Error("Ops job journal is unavailable");
  }
  let chain = Promise.resolve();

  const writeSnapshot = async (records: readonly PersistedOpsJob[]): Promise<void> => {
    const observed = current.filter(historical),
      fresh = records.map(parseJob);
    if (fresh.some(historical)) throw Error("Historical pull cannot enter the worker journal");
    const validated = [...observed, ...fresh];
    if (validated.length > maxEntries) throw new Error("Ops job journal capacity exceeded");
    for (const record of validated) {
      const retained = current.find(
        (prior) =>
          prior.operationId === record.operationId ||
          (prior.role === record.role && prior.operationKey === record.operationKey),
      );
      if (
        retained &&
        (retained.operationId !== record.operationId ||
          retained.operationKey !== record.operationKey ||
          retained.role !== record.role ||
          retained.fingerprint !== record.fingerprint ||
          retained.executionVersion !== record.executionVersion ||
          retained.requestVersion !== record.requestVersion ||
          retained.admittedAt !== record.admittedAt ||
          retained.deadlineAt !== record.deadlineAt ||
          retained.operationFingerprint !== record.operationFingerprint ||
          retained.requestedDeadlineAt !== record.requestedDeadlineAt ||
          retained.deploymentBudgetMs !== record.deploymentBudgetMs ||
          JSON.stringify(retained.parent) !== JSON.stringify(record.parent))
      )
        throw Error("Retained execution identity is immutable");
    }
    const ids = new Set(validated.map((entry) => entry.operationId));
    const keys = new Set(validated.map((entry) => `${entry.role}:${entry.operationKey}`));
    if (ids.size !== validated.length || keys.size !== validated.length) {
      throw new Error("Ops job journal contains duplicate identity");
    }
    const bytes = Buffer.from(JSON.stringify({ version: 2, jobs: validated }), "utf8");
    if (bytes.byteLength > maxBytes) throw new Error("Ops job journal capacity exceeded");
    const directory = dirname(path);
    const temporary = join(directory, `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, path);
      renamed = true;
      await syncDirectory(directory);
      current = validated.map((entry) => structuredClone(entry));
    } finally {
      await file?.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  };

  const journal: OpsJobJournal = {
    records: () =>
      current
        .filter((entry): entry is PersistedOpsJob => !historical(entry))
        .map((entry) => structuredClone(entry)),
    historicalPullRecords: () => current.filter(historical).map((entry) => structuredClone(entry)),
    replace: (records) => {
      const snapshot = records.map((entry) => structuredClone(entry));
      const next = chain.then(() => writeSnapshot(snapshot));
      chain = next.catch(() => undefined);
      return next;
    },
  };

  const interrupted = journal
    .records()
    .some((entry) => ["queued", "running", "termination_pending"].includes(entry.state));
  try {
    if (interrupted) {
      const timestamp = now().toISOString();
      await journal.replace(
        journal.records().map((entry) =>
          ["queued", "running", "termination_pending"].includes(entry.state)
            ? {
                ...entry,
                ...(entry.deadlineAt !== undefined && entry.deadlineAt <= now().getTime()
                  ? {
                      terminationRequestedAt:
                        entry.terminationRequestedAt ?? new Date(entry.deadlineAt).toISOString(),
                    }
                  : {}),
                ...(entry.progressResult ? { failureResult: entry.progressResult } : {}),
                progressResult: undefined,
                state: "failed" as const,
                updatedAt: timestamp,
                terminalAt: timestamp,
                errorClass: "recovery_required" as const,
              }
            : entry,
        ),
      );
    } else {
      await journal.replace(journal.records());
    }
  } catch {
    throw new Error("Ops job journal is unavailable");
  }
  productionJournalIndexes.set(journal, {
    path: join(realpathSync(dirname(path)), basename(resolve(path))),
    read: () =>
      current
        .filter((entry): entry is PersistedOpsJob => !historical(entry))
        .map((entry) => structuredClone(entry)),
  });
  return journal;
}
