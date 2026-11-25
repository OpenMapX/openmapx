import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type JournalExecution,
  journalExecutionSchema,
  type LeaseChildRef,
  leaseChildRefSchema,
} from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  configurationApplyResultSchema,
  isTrustedConfigurationApplyOperation,
  OPS_KIND_POLICIES,
  OPS_PUBLIC_ERROR_MESSAGES,
  type OpsErrorClass,
  type OpsFailureResult,
  type OpsJobState,
  type OpsOperation,
  type OpsRole,
  type OpsSettlement,
  opsFailureResultSchema,
  opsOperationFingerprint,
  opsOperationSchema,
  opsResourceId,
  opsSettlementSchema,
  type ProcessDiagnostics,
  parseBoundedOpsResult,
  processDiagnosticsSchema,
  type RetainedExecutionAdmission,
  settlementOfConfigurationApply,
  validateRetainedExecutionAdmission,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";

const { OPS_JOB_JOURNAL_FILE, OPS_JOB_JOURNAL_VERSION } = services;
/** The version of a row's execution identity fields. */
export const JOURNAL_EXECUTION_VERSION = 1;
// Twice the server capacity: new work and entries needing recovery each have half.
const OPS_JOB_JOURNAL_MAX_ENTRIES = 512;
const OPS_JOB_JOURNAL_MAX_BYTES = 24 * 1024 * 1024;
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
type TerminalJobState = "succeeded" | "failed" | "timed_out";
const TERMINAL_STATES = new Set<OpsJobState>(["succeeded", "failed", "timed_out"]);
const ERROR_CLASSES = new Set<OpsErrorClass>(
  Object.keys(OPS_PUBLIC_ERROR_MESSAGES) as OpsErrorClass[],
);

export interface PersistedOpsJob {
  /** A data-manager child: its row in the lease store, under data-manager's lease. */
  leaseChild?: LeaseChildRef;
  executionVersion: typeof JOURNAL_EXECUTION_VERSION;
  /** The ops protocol version of the release that admitted the operation. */
  requestVersion: number;
  admittedAt: number;
  deadlineAt: number;
  operationFingerprint: string;
  requestedDeadlineAt?: number;
  deploymentBudgetMs: number;
  parent?: RetainedExecutionAdmission["parent"];
  diagnostics?: ProcessDiagnostics;
  failureResult?: OpsFailureResult;
  /** Private checkpoint, never a terminal outcome or authority. */
  progressResult?: OpsFailureResult;
  /** Only the API and data-manager submit journaled operations. */
  role: Exclude<OpsRole, "host-cli">;
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
  /** The job failed because the agent stopped while it ran, not by its own
   * failure: its outcome is unknown. */
  interrupted?: true;
  /** The execution this operation runs as: what its admission adds to the
   * operation, when its effect started, its settlement and its children. */
  execution?: JournalExecution;
}

/**
 * A finished row another release wrote, whose operation, result or execution
 * this release's schemas do not read. Its identity is checked like any row's;
 * the rest is kept as written until the row is pruned, and a read of it
 * reports that another release recorded it.
 */
export interface ForeignOpsJob {
  role: Exclude<OpsRole, "host-cli">;
  operationId: string;
  operationKey: string;
  fingerprint: string;
  resourceId: string;
  requestVersion: number;
  state: TerminalJobState;
  submittedAt: string;
  updatedAt: string;
  terminalAt: string;
  /** Kept until an operator retries with a new operation, like any such row. */
  recoveryRequired: boolean;
  /** What a succeeded configuration apply settled, readable by every release. */
  settlement?: OpsSettlement;
  /** The row as written, rewritten unchanged. */
  row: Readonly<Record<string, unknown>>;
}

export interface OpsJobJournal {
  records(): readonly PersistedOpsJob[];
  foreignRecords(): readonly ForeignOpsJob[];
  /**
   * Writes `records` and the retained foreign rows: those named in `foreign`
   * by operation id, or all of them when it is omitted.
   */
  replace(records: readonly PersistedOpsJob[], foreign?: readonly string[]): Promise<void>;
}
export interface OpenOpsJobJournalOptions {
  now?: () => Date;
  maxEntries?: number;
  maxBytes?: number;
}

/** The part of a row's execution fixed at admission. */
function admissionOf({ progress: _progress, ...admission }: JournalExecution) {
  return admission;
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

/**
 * The settlement a succeeded row records beside its result: the outcome of a
 * configuration apply, also of the one a maintenance apply committed.
 */
function settlementOf(job: {
  operation: OpsOperation;
  state: unknown;
  result?: unknown;
}): OpsSettlement | undefined {
  if (job.state !== "succeeded") return undefined;
  if (isTrustedConfigurationApplyOperation(job.operation))
    return settlementOfConfigurationApply(configurationApplyResultSchema.parse(job.result));
  if (job.operation.kind !== "configurationMaintenance.apply") return undefined;
  const generation = (job.result as { generation?: unknown }).generation;
  return generation
    ? settlementOfConfigurationApply(configurationApplyResultSchema.parse(generation))
    : undefined;
}

/** A row as written: the job and, when it has one, its settlement. */
function rowOf(job: PersistedOpsJob): Record<string, unknown> {
  const settlement = settlementOf(job);
  return settlement ? { ...job, settlement } : { ...job };
}

/**
 * A row's identity: its ids, keys, role, state, timestamps and settlement.
 * Every row must have one this release reads, whichever release wrote it, or
 * the journal is refused. The writer's protocol version is data, not a
 * requirement.
 */
function parseIdentity(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const raw = value as Record<string, unknown>;
  const terminal = TERMINAL_STATES.has(raw.state as OpsJobState);
  if (
    !Number.isSafeInteger(raw.requestVersion) ||
    (raw.requestVersion as number) < 1 ||
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
    raw.admittedAt !== Date.parse(raw.submittedAt as string) ||
    !Number.isSafeInteger(raw.deadlineAt) ||
    (terminal ? !iso(raw.terminalAt) : raw.terminalAt !== undefined) ||
    (raw.terminationRequestedAt !== undefined && !iso(raw.terminationRequestedAt)) ||
    (raw.settlement !== undefined &&
      (raw.state !== "succeeded" || !opsSettlementSchema.safeParse(raw.settlement).success))
  ) {
    throw new Error("invalid");
  }
  return raw;
}

/** Keeps a row this release's schemas do not read. One that had not finished
 * fails as needing recovery, as an interrupted row of this release does. */
function foreignJob(identity: Record<string, unknown>, now: () => Date): ForeignOpsJob {
  let row = identity;
  if (!TERMINAL_STATES.has(identity.state as OpsJobState)) {
    const timestamp = now().toISOString();
    const { progressResult, result: _result, ...rest } = identity;
    row = {
      ...rest,
      ...(progressResult !== undefined ? { failureResult: progressResult } : {}),
      state: "failed",
      errorClass: "recovery_required",
      updatedAt: timestamp,
      terminalAt: timestamp,
      interrupted: true,
    };
  }
  return {
    role: row.role as ForeignOpsJob["role"],
    operationId: row.operationId as string,
    operationKey: row.operationKey as string,
    fingerprint: row.fingerprint as string,
    resourceId: row.resourceId as string,
    requestVersion: row.requestVersion as number,
    state: row.state as TerminalJobState,
    submittedAt: row.submittedAt as string,
    updatedAt: row.updatedAt as string,
    terminalAt: row.terminalAt as string,
    recoveryRequired: row.state === "failed" && row.errorClass === "recovery_required",
    ...(row.settlement !== undefined
      ? { settlement: opsSettlementSchema.parse(row.settlement) }
      : {}),
    row,
  };
}

/** A row this release reads whole: its identity, and its operation, result
 * and execution under the current schemas. */
function parseJob(value: unknown): PersistedOpsJob {
  const raw = parseIdentity(value);
  if (
    !exactKeys(raw, [
      "executionVersion",
      "leaseChild",
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
      "interrupted",
      "execution",
      "settlement",
    ]) ||
    raw.executionVersion !== JOURNAL_EXECUTION_VERSION ||
    (raw.interrupted !== undefined && (raw.interrupted !== true || raw.state !== "failed")) ||
    (raw.errorClass !== undefined &&
      (typeof raw.errorClass !== "string" || !ERROR_CLASSES.has(raw.errorClass as OpsErrorClass)))
  ) {
    throw new Error("invalid");
  }
  if (raw.leaseChild !== undefined) leaseChildRefSchema.parse(raw.leaseChild);
  if (raw.execution !== undefined) raw.execution = journalExecutionSchema.parse(raw.execution);
  const operation = opsOperationSchema.parse(raw.operation);
  if (
    opsOperationFingerprint(operation) !== raw.operationFingerprint ||
    opsResourceId(operation) !== raw.resourceId
  ) {
    throw new Error("invalid");
  }
  validateRetainedExecutionAdmission(operation.kind, raw as unknown as RetainedExecutionAdmission);
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
    parseBoundedOpsResult(operation.kind, raw.result);
  } else if (state === "failed" || state === "timed_out") {
    if (raw.result !== undefined || raw.errorClass === undefined || raw.terminalAt === undefined)
      throw new Error("invalid");
  } else if (
    raw.result !== undefined ||
    raw.errorClass !== undefined ||
    raw.terminalAt !== undefined
  ) {
    throw new Error("invalid");
  }
  // The settlement restates the result; a row whose settlement differs is not
  // one this release wrote.
  if (
    canonicalJson(raw.settlement ?? null) !==
    canonicalJson(settlementOf({ operation, state, result: raw.result }) ?? null)
  )
    throw new Error("invalid");
  delete raw.settlement;
  if (raw.progressResult === undefined) delete raw.progressResult;
  return raw as unknown as PersistedOpsJob;
}

function uniqueIdentities(
  rows: readonly { operationId: string; operationKey: string; role: string }[],
): boolean {
  const ids = new Set(rows.map((entry) => entry.operationId));
  const keys = new Set(rows.map((entry) => `${entry.role}:${entry.operationKey}`));
  return ids.size === rows.length && keys.size === rows.length;
}

function parseFile(
  bytes: Uint8Array,
  maxEntries: number,
  now: () => Date,
): { jobs: PersistedOpsJob[]; foreign: ForeignOpsJob[] } {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const decoded = JSON.parse(text) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid");
  const raw = decoded as Record<string, unknown>;
  if (
    Object.keys(raw).sort().join(",") !== "jobs,version" ||
    raw.version !== OPS_JOB_JOURNAL_VERSION ||
    !Array.isArray(raw.jobs) ||
    raw.jobs.length > maxEntries
  ) {
    throw new Error("invalid");
  }
  const jobs: PersistedOpsJob[] = [];
  const foreign: ForeignOpsJob[] = [];
  for (const entry of raw.jobs) {
    const identity = parseIdentity(entry);
    let job: PersistedOpsJob | undefined;
    try {
      job = parseJob(structuredClone(identity));
    } catch {
      foreign.push(foreignJob(identity, now));
    }
    if (job) jobs.push(job);
  }
  if (!uniqueIdentities([...jobs, ...foreign])) throw new Error("invalid");
  return { jobs, foreign };
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
  if (basename(path) !== OPS_JOB_JOURNAL_FILE) throw new Error("invalid journal path");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(directory);
  const orphanPattern = /^\.jobs\.json\.[a-f0-9]{24}\.tmp$/;
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
  let current: PersistedOpsJob[] = [];
  let foreign: ForeignOpsJob[] = [];
  try {
    await prepareJournalDirectory(path);
    const bytes = await safeRead(path, maxBytes);
    if (bytes) ({ jobs: current, foreign } = parseFile(bytes, maxEntries, now));
  } catch {
    throw new Error("Ops job journal is unavailable");
  }
  let chain = Promise.resolve();

  const writeSnapshot = async (
    records: readonly PersistedOpsJob[],
    keep: readonly string[] | undefined,
  ): Promise<void> => {
    const validated = records.map((record) => parseJob(rowOf(record)));
    const retainedForeign =
      keep === undefined
        ? foreign
        : keep.map((operationId) => {
            const row = foreign.find((entry) => entry.operationId === operationId);
            if (!row) throw Error("Unknown foreign journal row");
            return row;
          });
    if (validated.length + retainedForeign.length > maxEntries)
      throw new Error("Ops job journal capacity exceeded");
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
          retained.admittedAt !== record.admittedAt ||
          retained.deadlineAt !== record.deadlineAt ||
          retained.operationFingerprint !== record.operationFingerprint ||
          retained.requestedDeadlineAt !== record.requestedDeadlineAt ||
          retained.deploymentBudgetMs !== record.deploymentBudgetMs ||
          JSON.stringify(retained.parent) !== JSON.stringify(record.parent) ||
          (retained.execution &&
            canonicalJson(admissionOf(retained.execution)) !==
              canonicalJson(record.execution ? admissionOf(record.execution) : null)))
      )
        throw Error("Retained execution identity is immutable");
    }
    if (!uniqueIdentities([...validated, ...retainedForeign])) {
      throw new Error("Ops job journal contains duplicate identity");
    }
    const bytes = Buffer.from(
      JSON.stringify({
        version: OPS_JOB_JOURNAL_VERSION,
        jobs: [...validated.map(rowOf), ...retainedForeign.map((entry) => entry.row)],
      }),
      "utf8",
    );
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
      foreign = retainedForeign;
    } finally {
      await file?.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  };

  const journal: OpsJobJournal = {
    records: () => current.map((entry) => structuredClone(entry)),
    foreignRecords: () => foreign.map((entry) => structuredClone(entry)),
    replace: (records, keep) => {
      const snapshot = records.map((entry) => structuredClone(entry));
      const kept = keep === undefined ? undefined : [...keep];
      const next = chain.then(() => writeSnapshot(snapshot, kept));
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
                interrupted: true as const,
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
  return journal;
}
