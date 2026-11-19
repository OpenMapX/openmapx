import {
  CONTROL_PRUNE_AFTER_MS,
  closeArtifactTargetLeaseHandle,
  type ExecutionHandle,
  journalExecution,
  journalExecutionRow,
  journalExecutionSchema,
  type OwningExecutionRows,
  type TargetLeaseAuthority,
} from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  type ExecutionRef,
  OPS_MAX_RESULT_BYTES,
  OPS_PROTOCOL_VERSION,
  type OpsAdmission,
  type OpsErrorClass,
  type OpsEventBatch,
  type OpsJobState,
  type OpsJobStatus,
  type OpsOperation,
  opsFailureResultSchema,
  opsKindRequiresControlAuthority,
  parseControlRootOperationKey,
} from "@openmapx/core/ops";
import type { OpsJobJournal, PersistedOpsJob } from "./journal";

export const DEFAULT_JOB_ENTRIES = 256;
const MAX_RETAINED_EVENTS_PER_JOB = 64;
const MAX_RETAINED_EVENT_BYTES_PER_JOB = 32 * 1024;
// New work and entries that need recovery have a bound each.
export const OPS_AGENT_RETENTION_LIMITS = {
  maxJobs: 2 * DEFAULT_JOB_ENTRIES,
  maxEventsPerJob: MAX_RETAINED_EVENTS_PER_JOB,
  maxEventBytesPerJob: MAX_RETAINED_EVENT_BYTES_PER_JOB,
  maxResultBytesPerJob: OPS_MAX_RESULT_BYTES,
  maxAggregateJournalBytes: 24 * 1024 * 1024,
  maxAggregateEventBytes: 2 * DEFAULT_JOB_ENTRIES * MAX_RETAINED_EVENT_BYTES_PER_JOB,
} as const;

export interface JobRecord extends Omit<PersistedOpsJob, "terminalAt"> {
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
  terminalAt?: number;
  terminationRequestedAt?: string;
  cursor: number;
  events: OpsEventBatch["events"];
  eventBytes: number;
  eventsTruncated: boolean;
}

export type TransitionUpdates = Partial<
  Pick<
    JobRecord,
    "result" | "errorClass" | "terminalAt" | "terminationRequestedAt" | "failureResult"
  >
>;
export type TerminalState = "succeeded" | "failed" | "timed_out";
const isTerminalState = (state: OpsJobState): state is TerminalState =>
  state === "succeeded" || state === "failed" || state === "timed_out";

/** The execution authority and target lease a root or borrowed child runs under. */
export interface JobHandles {
  authority: ExecutionHandle | undefined;
  lease: TargetLeaseAuthority | undefined;
}
/** An outcome a kind establishes before its terminal write, replacing the worker's. */
export interface TerminalOutcome {
  state: OpsJobState;
  updates: TransitionUpdates;
  updatedAt?: string;
}
/** What a terminal write settles beyond the journal row, per kind. */
export interface TerminalSettlement<Observation> {
  /** Runs outside the admission lock: slow containment and published reads. */
  observe(job: JobRecord, state: TerminalState, handles: JobHandles): Promise<Observation>;
  /** Runs under the admission lock before the journal write: receipts and the lease. */
  settle(input: {
    job: JobRecord;
    state: OpsJobState;
    updates: TransitionUpdates;
    handles: JobHandles;
    observation: Observation | undefined;
  }): Promise<TerminalOutcome & { beforeWrite?: () => Promise<void> }>;
  /** A termination request reaches the root's records and lease. */
  cancel(handles: JobHandles): Promise<void>;
  /** A kind whose success replaces the evidence its failure would keep. */
  dropsFailureResultOnSuccess(job: JobRecord): boolean;
}

export function executionFor(job: JobRecord): ExecutionRef {
  return Object.freeze({
    executor: "ops-agent",
    principal: job.role,
    executionId: job.operationId,
    operationKey: job.operationKey,
    operationFingerprint: job.operationFingerprint,
    fingerprint: job.fingerprint,
    deadlineAt: job.deadlineAt,
  });
}

const recoveryRequired = (job: JobRecord) =>
  job.state === "failed" && job.errorClass === "recovery_required";

/**
 * The agent's operations: the journal rows and their in-memory events, the
 * handles their executions run under, the admission lock every journal write
 * takes, and the one transition that records a state.
 */
export class JobTable<Observation = unknown> {
  readonly byId = new Map<string, JobRecord>();
  readonly byKey = new Map<string, JobRecord>();
  readonly activeControllers = new Map<string, AbortController>();
  readonly activeSettlements = new Map<string, Promise<void>>();
  readonly leases = new Map<string, TargetLeaseAuthority>();
  readonly authorities = new Map<string, ExecutionHandle>();
  readonly stickyRecoveryRequired = new Set<string>();
  /** Trusted configuration applies whose terminal event is not published yet. */
  readonly configurationResultsSettling = new Set<string>();
  /** Requests holding an execution slot, admission to settlement. */
  active = 0;
  private admissionTail = Promise.resolve();
  private diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
  private diagnosticWriteActive = false;
  private readonly dirtyDiagnostics = new Set<string>();

  constructor(
    private readonly options: {
      journal: OpsJobJournal;
      now: () => Date;
      maxJobEntries: number;
      jobRetentionMs: number;
      controlRoots: boolean;
      settlement: TerminalSettlement<Observation>;
    },
  ) {
    const restoredRecords = options.journal.records();
    if (restoredRecords.length > 2 * options.maxJobEntries) {
      throw new Error("Ops job journal exceeds the configured server capacity");
    }
    for (const persisted of restoredRecords) {
      const restored: JobRecord = {
        ...persisted,
        terminalAt:
          persisted.terminalAt === undefined ? undefined : Date.parse(persisted.terminalAt),
        cursor: 0,
        events: [],
        eventBytes: 0,
        eventsTruncated: true,
      };
      this.byId.set(restored.operationId, restored);
      this.byKey.set(`${restored.role}:${restored.operationKey}`, restored);
    }
  }

  async withAdmissionLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.admissionTail;
    let release!: () => void;
    this.admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** Writes every row, with `replacing` written in place of its row or added. */
  async persist(replacing?: { job: JobRecord; with: JobRecord }): Promise<void> {
    const rows = [...this.byId.values()].map((entry) =>
      persisted(entry === replacing?.job ? replacing.with : entry),
    );
    if (replacing && !this.byId.has(replacing.job.operationId))
      rows.push(persisted(replacing.with));
    await this.options.journal.replace(rows);
  }

  /** Adds an admitted row after its first journal write. */
  add(job: JobRecord): void {
    this.byId.set(job.operationId, job);
    this.byKey.set(`${job.role}:${job.operationKey}`, job);
  }

  scheduleDiagnostics(job: JobRecord): void {
    this.dirtyDiagnostics.add(job.operationId);
    if (this.diagnosticTimer !== undefined) return;
    this.diagnosticTimer = setTimeout(() => {
      this.diagnosticTimer = undefined;
      void this.flushDiagnostics();
    }, 1000);
    this.diagnosticTimer.unref?.();
  }

  private async flushDiagnostics(): Promise<void> {
    if (this.diagnosticWriteActive || this.dirtyDiagnostics.size === 0) return;
    this.diagnosticWriteActive = true;
    this.dirtyDiagnostics.clear();
    try {
      await this.withAdmissionLock(() => this.persist());
    } catch {
      /* Projection persistence failure never terminates owned backend work. */
    } finally {
      this.diagnosticWriteActive = false;
    }
  }

  /** Writes pending diagnostics and closes the handles still held. */
  async close(): Promise<void> {
    if (this.diagnosticTimer !== undefined) clearTimeout(this.diagnosticTimer);
    await this.flushDiagnostics();
    for (const lease of this.leases.values()) closeArtifactTargetLeaseHandle(lease);
    this.leases.clear();
    this.authorities.clear();
  }

  /** Control-authority entries stay until 72 hours after terminal and until
   * their timed root key has expired, so an API restarting in that window can
   * still read them. Other entries stay for the configured job retention. */
  private retained(job: JobRecord, nowMs: number): boolean {
    if (
      recoveryRequired(job) ||
      this.configurationResultsSettling.has(job.operationId) ||
      job.terminalAt === undefined
    )
      return true;
    // An execution's row goes with the control prune, which also checks its
    // settlement, its key's expiry and the leases it ran under.
    if (job.execution) return true;
    if (!this.options.controlRoots || !opsKindRequiresControlAuthority(job.operation.kind))
      return job.terminalAt + this.options.jobRetentionMs > nowMs;
    let notAfter = 0;
    try {
      notAfter = parseControlRootOperationKey(job.operationKey).notAfter;
    } catch {
      /* A derived child key carries no expiry of its own. */
    }
    return job.terminalAt + CONTROL_PRUNE_AFTER_MS > nowMs || notAfter > nowMs;
  }

  async prune(nowMs: number): Promise<void> {
    await this.withAdmissionLock(async () => {
      const retained = [...this.byId.values()].filter((job) => this.retained(job, nowMs));
      if (retained.length === this.byId.size) return;
      await this.options.journal.replace(retained.map(persisted));
      for (const [id, job] of this.byId)
        if (!this.retained(job, nowMs)) {
          this.byId.delete(id);
          this.byKey.delete(`${job.role}:${job.operationKey}`);
        }
    });
  }

  /** Another journal entry still needs this key's records: an entry of that
   * key without a row of its own, or a maintenance control of that
   * preparation. */
  references(operationKey: string): boolean {
    for (const job of this.byId.values())
      if (
        (job.operationKey === operationKey && !job.execution) ||
        ("prepareOperationKey" in job.operation &&
          job.operation.prepareOperationKey === operationKey)
      )
        return true;
    return false;
  }

  /**
   * The execution rows of the agent's own operations, kept on their journal
   * rows. A change is applied to the row in memory, so every later journal
   * write carries it, and resolves once a journal write with it is durable.
   */
  executionRows(): OwningExecutionRows {
    const jobOf = (key: string) => {
      for (const job of this.byId.values()) if (job.operationKey === key) return job;
      return undefined;
    };
    // Only a finished row whose outcome needs no recovery is offered to the prune.
    const offered = (job: JobRecord) =>
      job.execution !== undefined &&
      job.terminalAt !== undefined &&
      !recoveryRequired(job) &&
      !this.configurationResultsSettling.has(job.operationId) &&
      !this.activeControllers.has(job.operationId);
    return {
      owns: (key) => jobOf(key) !== undefined,
      read: (key) => {
        const job = jobOf(key);
        return job && journalExecutionRow(job);
      },
      admit: async (row) => {
        const job = jobOf(row.admission.execution.operationKey);
        if (!job) throw Error("Missing journal operation");
        const next = journalExecution(job, row);
        if (job.execution) {
          const { progress: _held, ...held } = job.execution,
            { progress: _next, ...admitted } = next;
          if (canonicalJson(held) !== canonicalJson(admitted))
            throw Error("Conflicting retained execution identity");
          return "retained";
        }
        job.execution = next;
        await this.persist();
        return "admitted";
      },
      update: async (key, change) => {
        const job = jobOf(key);
        if (!job?.execution) throw Error("Missing execution row");
        const progress = structuredClone(job.execution.progress);
        const result = change(progress);
        job.execution = journalExecutionSchema.parse({ ...job.execution, progress });
        await this.persist();
        return result;
      },
      keys: (limit) => {
        const keys = [...this.byId.values()].filter(offered).map((job) => job.operationKey);
        return { keys: keys.slice(0, limit), complete: keys.length <= limit };
      },
      remove: (keys) =>
        this.withAdmissionLock(async () => {
          const removed = [...this.byId.values()].filter(
            (job) => offered(job) && keys.includes(job.operationKey),
          );
          if (!removed.length) return;
          await this.options.journal.replace(
            [...this.byId.values()].filter((job) => !removed.includes(job)).map(persisted),
          );
          for (const job of removed) {
            this.byId.delete(job.operationId);
            this.byKey.delete(`${job.role}:${job.operationKey}`);
            this.authorities.delete(job.operationId);
          }
        }),
    };
  }

  /** Entries that need recovery are bounded separately, so they never use up
   * the capacity for new work. */
  full(): boolean {
    let recovery = 0,
      total = 0;
    for (const job of this.byId.values()) {
      total++;
      if (recoveryRequired(job)) recovery++;
    }
    return total - recovery >= this.options.maxJobEntries || recovery >= this.options.maxJobEntries;
  }

  /** How many rows match. */
  count(predicate: (job: JobRecord) => boolean): number {
    return [...this.byId.values()].filter(predicate).length;
  }

  pushEvent(job: JobRecord, event: OpsEventBatch["events"][number]): void {
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    while (
      job.events.length > 0 &&
      (job.events.length >= MAX_RETAINED_EVENTS_PER_JOB ||
        job.eventBytes + bytes > MAX_RETAINED_EVENT_BYTES_PER_JOB)
    ) {
      const removed = job.events.shift();
      if (removed) job.eventBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
      job.eventsTruncated = true;
    }
    job.events.push(event);
    job.eventBytes += bytes;
  }

  /** Records a state change of a running job's backend as a state event. */
  pushState(job: JobRecord, state: OpsJobState = this.outwardState(job)): void {
    job.cursor += 1;
    this.pushEvent(job, { cursor: job.cursor, type: "state", state });
  }

  outwardState(job: JobRecord): OpsJobState {
    return this.configurationResultsSettling.has(job.operationId) ? "running" : job.state;
  }

  /** A terminal state is final; only an outcome still needing recovery may be replaced. */
  private final(job: JobRecord): boolean {
    return job.terminalAt !== undefined && !recoveryRequired(job);
  }

  handles(job: JobRecord): JobHandles {
    return {
      authority: this.authorities.get(job.operationId),
      lease: this.leases.get(job.operationId),
    };
  }

  async transition(
    job: JobRecord,
    state: OpsJobState,
    updates: TransitionUpdates = {},
  ): Promise<void> {
    const { now, journal, settlement } = this.options;
    // Slow containment and published reads happen before the lock.
    const observation =
      isTerminalState(state) && !this.final(job)
        ? await settlement.observe(job, state, this.handles(job))
        : undefined;
    await this.withAdmissionLock(async () => {
      if (state === "termination_pending" && job.terminalAt !== undefined) return;
      let updatedAt = now().toISOString();
      // A recorded terminal is final: the same outcome again changes nothing,
      // and only an outcome still needing recovery may be replaced by the one
      // recovery established.
      if (this.final(job)) {
        if (
          state === job.state &&
          canonicalJson(updates.result ?? null) === canonicalJson(job.result ?? null) &&
          (updates.errorClass ?? null) === (job.errorClass ?? null)
        )
          return;
        throw Error("Recorded terminal state is final");
      }
      const handles = this.handles(job);
      if (state === "termination_pending") await settlement.cancel(handles);
      let beforeWrite: (() => Promise<void>) | undefined;
      if (handles.authority && isTerminalState(state)) {
        const settled = await settlement.settle({ job, state, updates, handles, observation });
        ({ state, updates, beforeWrite } = settled);
        updatedAt = settled.updatedAt ?? updatedAt;
      }
      if ((state === "failed" || state === "timed_out") && job.progressResult)
        updates = {
          ...updates,
          failureResult: opsFailureResultSchema.parse({
            ...job.progressResult,
            ...updates.failureResult,
          }),
        };
      const candidate: JobRecord = { ...job, ...updates, state, updatedAt };
      const dropFailure = state === "succeeded" && settlement.dropsFailureResultOnSuccess(job);
      if (isTerminalState(state)) delete candidate.progressResult;
      if (dropFailure) delete candidate.failureResult;
      await beforeWrite?.();
      await journal.replace(
        [...this.byId.values()].map((entry) => persisted(entry === job ? candidate : entry)),
      );
      Object.assign(job, updates);
      if (isTerminalState(state)) delete job.progressResult;
      if (dropFailure) delete job.failureResult;
      job.updatedAt = updatedAt;
      job.state = state;
      if (handles.lease && isTerminalState(state)) {
        closeArtifactTargetLeaseHandle(handles.lease);
        this.leases.delete(job.operationId);
      }
      this.pushState(job);
    });
  }

  /** Marks a job recovery_required in memory when its journal write failed. */
  forceRecoveryRequired(job: JobRecord): void {
    const now = this.options.now();
    this.stickyRecoveryRequired.add(job.operationId);
    const workerActive = this.activeControllers.has(job.operationId);
    job.result = undefined;
    job.errorClass = workerActive ? undefined : "recovery_required";
    job.terminalAt = workerActive ? undefined : now.getTime();
    job.updatedAt = now.toISOString();
    job.state = workerActive ? "termination_pending" : "failed";
    this.pushState(job, job.state);
  }

  /** Replaces a row with an outcome established at startup, then writes the journal. */
  async restoreOutcome(job: JobRecord, outcome: Partial<JobRecord>): Promise<void> {
    const restored: JobRecord = { ...job, ...outcome };
    await this.persist({ job, with: restored });
    Object.assign(job, restored);
  }

  admission(job: JobRecord): OpsAdmission {
    return {
      version: OPS_PROTOCOL_VERSION,
      execution: "async",
      operationId: job.operationId,
      operationKey: job.operationKey,
      kind: job.operation.kind,
      state: this.outwardState(job),
      ...identityFor(job),
    };
  }

  status(job: JobRecord, internalTerminal = false): OpsJobStatus {
    const hidden = !internalTerminal && this.configurationResultsSettling.has(job.operationId);
    return {
      version: OPS_PROTOCOL_VERSION,
      ...identityFor(job),
      ...(job.diagnostics ? { diagnostics: job.diagnostics } : {}),
      ...(job.failureResult ? { failureResult: job.failureResult } : {}),
      operationId: job.operationId,
      operationKey: job.operationKey,
      kind: job.operation.kind,
      resourceId: job.resourceId,
      state: internalTerminal ? job.state : this.outwardState(job),
      submittedAt: job.submittedAt,
      updatedAt: job.updatedAt,
      ...(job.terminationRequestedAt === undefined
        ? {}
        : { terminationRequestedAt: job.terminationRequestedAt }),
      ...(job.result === undefined || hidden ? {} : { result: job.result }),
      ...(job.errorClass === undefined || hidden ? {} : { errorClass: job.errorClass }),
    };
  }

  events(job: JobRecord, after: number, limit: number) {
    const events = job.events.filter((event) => event.cursor > after).slice(0, limit);
    return {
      version: 1 as const,
      operationId: job.operationId,
      nextCursor: events.at(-1)?.cursor ?? after,
      terminal:
        job.terminalAt !== undefined && !this.configurationResultsSettling.has(job.operationId),
      truncated: job.eventsTruncated,
      events,
    };
  }
}

function identityFor(job: JobRecord) {
  return { admittedAt: job.admittedAt, deadlineAt: job.deadlineAt, fingerprint: job.fingerprint };
}

function persisted(job: JobRecord): PersistedOpsJob {
  return {
    ...(job.leaseChild ? { leaseChild: job.leaseChild } : {}),
    executionVersion: 2,
    requestVersion: job.requestVersion,
    admittedAt: job.admittedAt,
    deadlineAt: job.deadlineAt,
    operationFingerprint: job.operationFingerprint,
    requestedDeadlineAt: job.requestedDeadlineAt,
    deploymentBudgetMs: job.deploymentBudgetMs,
    parent: job.parent,
    ...(job.diagnostics ? { diagnostics: job.diagnostics } : {}),
    ...(job.failureResult ? { failureResult: job.failureResult } : {}),
    ...(job.progressResult ? { progressResult: job.progressResult } : {}),
    role: job.role,
    operation: job.operation,
    operationId: job.operationId,
    operationKey: job.operationKey,
    fingerprint: job.fingerprint,
    resourceId: job.resourceId,
    state: job.state,
    submittedAt: job.submittedAt,
    updatedAt: job.updatedAt,
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.errorClass === undefined ? {} : { errorClass: job.errorClass }),
    ...(job.terminalAt === undefined ? {} : { terminalAt: new Date(job.terminalAt).toISOString() }),
    ...(job.terminationRequestedAt === undefined
      ? {}
      : { terminationRequestedAt: job.terminationRequestedAt }),
    ...(job.interrupted && job.state === "failed" ? { interrupted: true as const } : {}),
    ...(job.execution ? { execution: job.execution } : {}),
  };
}
