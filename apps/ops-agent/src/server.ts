import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import {
  OPS_KIND_POLICIES,
  OPS_MAX_CLOCK_SKEW_MS,
  OPS_MAX_EVENT_BATCH,
  OPS_MAX_EVENT_MESSAGE_BYTES,
  OPS_MAX_HTTP_RESPONSE_BYTES,
  OPS_MAX_REQUEST_TTL_MS,
  OPS_MAX_RESULT_BYTES,
  OPS_OPERATION_KINDS,
  OpsContractError,
  type OpsErrorClass,
  type OpsEventBatch,
  type OpsJobState,
  type OpsJobStatus,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResourcePolicy,
  type OpsRole,
  opsOperationFingerprint,
  opsResourceId,
  opsSuccess,
  parseBoundedOpsResult,
  parseOpsRequest,
  redactedOpsError,
} from "@openmapx/core/ops";
import Fastify, { type FastifyInstance } from "fastify";
import type { OpsJobJournal, PersistedOpsJob } from "./journal";
import { createPolicyResourceClaimer, type OpsResourceClaimer } from "./policy";
import {
  createUnavailableRuntime,
  dispatchOpsOperation,
  type OpsExecutionContext,
  OpsNotWiredError,
  type OpsRuntime,
  type OpsTrustedClaim,
} from "./runtime";

const DEFAULT_BODY_LIMIT = 32 * 1024;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_REPLAY_ENTRIES = 10_000;
const DEFAULT_JOB_ENTRIES = 256;
const DEFAULT_JOB_RETENTION_MS = 60 * 60_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 30_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 5_000;
const MAX_JOB_ID_ATTEMPTS = 8;
const MAX_RETAINED_EVENTS_PER_JOB = 64;
const MAX_RETAINED_EVENT_BYTES_PER_JOB = 32 * 1024;
export const OPS_AGENT_RETENTION_LIMITS = {
  maxJobs: DEFAULT_JOB_ENTRIES,
  maxEventsPerJob: MAX_RETAINED_EVENTS_PER_JOB,
  maxEventBytesPerJob: MAX_RETAINED_EVENT_BYTES_PER_JOB,
  maxResultBytesPerJob: OPS_MAX_RESULT_BYTES,
  maxAggregateJournalBytes: 24 * 1024 * 1024,
  maxAggregateEventBytes: DEFAULT_JOB_ENTRIES * MAX_RETAINED_EVENT_BYTES_PER_JOB,
} as const;
const FALLBACK_REQUEST_ID = "ops1_unavailable000000";
const OPERATION_KIND_SET = new Set<string>(OPS_OPERATION_KINDS);
const REQUEST_ID_PATTERN = /^ops1_[A-Za-z0-9_-]{16,64}$/;
const OPERATION_ID_PATTERN = /^job1_[A-Za-z0-9_-]{16,64}$/;

export interface OpsAuditEvent {
  role: OpsRole;
  kind: OpsOperationKind | "invalid";
  resourceId: string;
  result: "success" | "denied" | "error" | "timeout" | "terminated" | "late_completion";
  durationMs: number;
  errorClass?: OpsErrorClass;
}

export interface BuildOpsAgentServerOptions {
  tokens: Record<OpsRole, string>;
  resourcePolicy?: OpsResourcePolicy;
  resourceClaimer?: OpsResourceClaimer;
  journal?: OpsJobJournal;
  runtime?: OpsRuntime;
  dispatch?: (
    operation: OpsOperation,
    runtime: OpsRuntime,
    context: OpsExecutionContext,
  ) => Promise<unknown>;
  audit?: (event: OpsAuditEvent) => void;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  bodyLimit?: number;
  operationTimeoutMs?: number;
  maxConcurrency?: number;
  maxReplayEntries?: number;
  maxJobEntries?: number;
  jobRetentionMs?: number;
  claimTimeoutMs?: number;
}

interface JobRecord {
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
  terminalAt?: number;
  terminationRequestedAt?: string;
  cursor: number;
  events: OpsEventBatch["events"];
  eventBytes: number;
  eventsTruncated: boolean;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function resolveRole(
  authorization: string | undefined,
  tokens: Record<OpsRole, string>,
): OpsRole | null {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  const candidate = digest(match?.[1] ?? "");
  const apiMatches = timingSafeEqual(candidate, digest(tokens.api));
  const dataManagerMatches = timingSafeEqual(candidate, digest(tokens["data-manager"]));
  if (!match) return null;
  if (apiMatches) return "api";
  if (dataManagerMatches) return "data-manager";
  return null;
}

function validRequestId(value: unknown): string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : FALLBACK_REQUEST_ID;
}

function requestIdFromBody(body: unknown): string {
  return validRequestId(
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { requestId?: unknown }).requestId
      : undefined,
  );
}

class RequestGuardError extends Error {
  constructor(
    readonly errorClass: OpsErrorClass,
    readonly statusCode: number,
  ) {
    super(errorClass);
  }
}

class ReplayCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries: number) {}

  accept(requestId: string, expiresAt: number, now: number): void {
    for (const [id, expiry] of this.entries) if (expiry <= now) this.entries.delete(id);
    if (this.entries.has(requestId)) throw new RequestGuardError("replay", 409);
    if (this.entries.size >= this.maxEntries) throw new RequestGuardError("busy", 429);
    this.entries.set(requestId, expiresAt);
  }
}

function validateTiming(
  issuedAt: string,
  expiresAt: string,
  nowMs: number,
): { expiresAtMs: number } {
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (issuedAtMs > nowMs + OPS_MAX_CLOCK_SKEW_MS) throw new RequestGuardError("future", 400);
  if (expiresAtMs <= nowMs) throw new RequestGuardError("stale", 400);
  const ttl = expiresAtMs - issuedAtMs;
  if (ttl <= 0 || ttl > OPS_MAX_REQUEST_TTL_MS) {
    throw new RequestGuardError("validation", 400);
  }
  return { expiresAtMs };
}

function operationKindFromBody(body: unknown): OpsOperationKind | "invalid" {
  const operation =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { operation?: unknown }).operation
      : undefined;
  const kind =
    operation && typeof operation === "object" && !Array.isArray(operation)
      ? (operation as { kind?: unknown }).kind
      : undefined;
  return typeof kind === "string" && OPERATION_KIND_SET.has(kind)
    ? (kind as OpsOperationKind)
    : "invalid";
}

function immutableSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
    Object.freeze(entry);
  };
  freeze(snapshot);
  return snapshot;
}

function classify(error: unknown): { errorClass: OpsErrorClass; statusCode: number } {
  if (error instanceof OpsContractError) {
    return {
      errorClass: error.errorClass,
      statusCode: error.errorClass === "authorization" ? 403 : 400,
    };
  }
  if (error instanceof RequestGuardError) {
    return { errorClass: error.errorClass, statusCode: error.statusCode };
  }
  if (error instanceof OpsNotWiredError) return { errorClass: "not_wired", statusCode: 501 };
  return { errorClass: "runtime", statusCode: 500 };
}

export function buildOpsAgentServer(options: BuildOpsAgentServerOptions): FastifyInstance {
  if (options.tokens.api === options.tokens["data-manager"]) {
    throw new Error("Ops agent caller credentials must be distinct");
  }
  const app = Fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    requestTimeout: DEFAULT_ADMISSION_TIMEOUT_MS,
    connectionTimeout: DEFAULT_ADMISSION_TIMEOUT_MS,
  });
  const runtime = options.runtime ?? createUnavailableRuntime();
  const dispatch =
    options.dispatch ??
    ((operation, adapter, context) => dispatchOpsOperation(adapter, operation, context));
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const replay = new ReplayCache(options.maxReplayEntries ?? DEFAULT_REPLAY_ENTRIES);
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_CONCURRENCY;
  const maxJobEntries = Math.min(options.maxJobEntries ?? DEFAULT_JOB_ENTRIES, DEFAULT_JOB_ENTRIES);
  const jobRetentionMs = options.jobRetentionMs ?? DEFAULT_JOB_RETENTION_MS;
  const journal: OpsJobJournal =
    options.journal ??
    ({ records: () => [], replace: async () => undefined } satisfies OpsJobJournal);
  const resourceClaimer =
    options.resourceClaimer ?? createPolicyResourceClaimer(options.resourcePolicy ?? {});
  const jobsById = new Map<string, JobRecord>();
  const jobsByKey = new Map<string, JobRecord>();
  const activeControllers = new Map<string, AbortController>();
  const activeSettlements = new Map<string, Promise<void>>();
  const stickyRecoveryRequired = new Set<string>();
  let active = 0;
  let admissionTail = Promise.resolve();

  const withAdmissionLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = admissionTail;
    let release!: () => void;
    admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const restoredRecords = journal.records();
  if (restoredRecords.length > maxJobEntries) {
    throw new Error("Ops job journal exceeds the configured server capacity");
  }
  for (const persisted of restoredRecords) {
    const restored: JobRecord = {
      ...persisted,
      terminalAt: persisted.terminalAt === undefined ? undefined : Date.parse(persisted.terminalAt),
      cursor: 0,
      events: [],
      eventBytes: 0,
      eventsTruncated: true,
    };
    jobsById.set(restored.operationId, restored);
    jobsByKey.set(`${restored.role}:${restored.operationKey}`, restored);
  }

  const audit = (
    role: OpsRole,
    kind: OpsOperationKind | "invalid",
    resourceId: string,
    result: OpsAuditEvent["result"],
    startedAt: number,
    errorClass?: OpsErrorClass,
  ) => {
    try {
      options.audit?.({
        role,
        kind,
        resourceId,
        result,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(errorClass ? { errorClass } : {}),
      });
    } catch {
      // Audit is deliberately best effort and cannot change protocol state.
    }
  };

  const persisted = (job: JobRecord): PersistedOpsJob => ({
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
  });

  const pruneJobs = async (nowMs: number) => {
    await withAdmissionLock(async () => {
      const retained = [...jobsById.values()].filter(
        (job) =>
          (job.state === "failed" && job.errorClass === "recovery_required") ||
          job.terminalAt === undefined ||
          job.terminalAt + jobRetentionMs > nowMs,
      );
      if (retained.length === jobsById.size) return;
      await journal.replace(retained.map(persisted));
      for (const [id, job] of jobsById) {
        if (
          !(job.state === "failed" && job.errorClass === "recovery_required") &&
          job.terminalAt !== undefined &&
          job.terminalAt + jobRetentionMs <= nowMs
        ) {
          jobsById.delete(id);
          jobsByKey.delete(`${job.role}:${job.operationKey}`);
        }
      }
    });
  };

  const truncateUtf8 = (message: string, maxBytes: number): string => {
    let bytes = 0;
    let bounded = "";
    for (const character of message) {
      const size = Buffer.byteLength(character, "utf8");
      if (bytes + size > maxBytes) break;
      bounded += character;
      bytes += size;
    }
    return bounded;
  };

  const pushEvent = (job: JobRecord, event: OpsEventBatch["events"][number]) => {
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
  };

  const transition = async (
    job: JobRecord,
    state: OpsJobState,
    updates: Partial<Pick<JobRecord, "result" | "errorClass" | "terminalAt">> = {},
  ): Promise<void> => {
    await withAdmissionLock(async () => {
      const updatedAt = now().toISOString();
      const candidate: JobRecord = { ...job, ...updates, state, updatedAt };
      await journal.replace(
        [...jobsById.values()].map((entry) => persisted(entry === job ? candidate : entry)),
      );
      Object.assign(job, updates);
      job.updatedAt = updatedAt;
      job.state = state;
      job.cursor += 1;
      pushEvent(job, { cursor: job.cursor, type: "state", state });
    });
  };

  const forceRecoveryRequired = (job: JobRecord): void => {
    stickyRecoveryRequired.add(job.operationId);
    job.result = undefined;
    job.errorClass = "recovery_required";
    job.terminalAt = now().getTime();
    job.updatedAt = now().toISOString();
    job.state = "failed";
    job.cursor += 1;
    pushEvent(job, { cursor: job.cursor, type: "state", state: "failed" });
  };

  const contextFor = (
    job: JobRecord,
    signal: AbortSignal,
    claim: OpsExecutionContext["claim"],
  ): OpsExecutionContext => ({
    signal,
    claim,
    emitLog: (stream, message) => {
      const boundedMessage = truncateUtf8(message, OPS_MAX_EVENT_MESSAGE_BYTES);
      job.cursor += 1;
      pushEvent(job, {
        cursor: job.cursor,
        type: "log",
        stream,
        message: boundedMessage,
      });
    },
  });

  const statusFor = (job: JobRecord): OpsJobStatus => ({
    version: 1,
    operationId: job.operationId,
    operationKey: job.operationKey,
    kind: job.operation.kind,
    resourceId: job.resourceId,
    state: job.state,
    submittedAt: job.submittedAt,
    updatedAt: job.updatedAt,
    ...(job.terminationRequestedAt === undefined
      ? {}
      : { terminationRequestedAt: job.terminationRequestedAt }),
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.errorClass === undefined ? {} : { errorClass: job.errorClass }),
  });

  const runAsync = async (
    job: JobRecord,
    startedAt: number,
    claim: OpsExecutionContext["claim"],
    claimAdmission: OpsTrustedClaim["admission"],
  ) => {
    try {
      await transition(job, "running");
    } catch {
      forceRecoveryRequired(job);
      audit(job.role, job.operation.kind, job.resourceId, "error", startedAt, "runtime");
      active -= 1;
      throw new RequestGuardError("runtime", 500);
    }
    const controller = new AbortController();
    activeControllers.set(job.operationId, controller);
    const timeoutMs = Math.min(
      OPS_KIND_POLICIES[job.operation.kind].timeoutMs,
      options.operationTimeoutMs ?? Number.POSITIVE_INFINITY,
    );
    let timedOut = false;
    let terminalDurable = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void transition(job, "termination_pending").then(
        () => controller.abort(),
        () => controller.abort(),
      );
    }, timeoutMs);
    const settlement = Promise.resolve()
      .then(() => dispatch(job.operation, runtime, contextFor(job, controller.signal, claim)))
      .then(
        async (rawResult) => {
          clearTimeout(timer);
          try {
            if (stickyRecoveryRequired.has(job.operationId)) {
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                "error",
                startedAt,
                "recovery_required",
              );
            } else if (timedOut) {
              await transition(job, "timed_out", {
                errorClass: "timeout",
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                "late_completion",
                startedAt,
                "timeout",
              );
            } else if (job.state === "termination_pending") {
              await transition(job, "failed", {
                result: undefined,
                errorClass: "runtime",
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                "terminated",
                startedAt,
                "runtime",
              );
            } else {
              const result = parseBoundedOpsResult(job.operation.kind, rawResult);
              await transition(job, "succeeded", {
                result,
                errorClass: undefined,
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(job.role, job.operation.kind, job.resourceId, "success", startedAt);
            }
          } catch {
            await transition(job, "failed", {
              result: undefined,
              errorClass: "runtime",
              terminalAt: now().getTime(),
            })
              .then(() => {
                terminalDurable = true;
              })
              .catch(() => forceRecoveryRequired(job));
            audit(job.role, job.operation.kind, job.resourceId, "error", startedAt, "runtime");
          } finally {
            if (terminalDurable) {
              await claimAdmission?.release().catch(async () => {
                stickyRecoveryRequired.add(job.operationId);
                await transition(job, "failed", {
                  result: undefined,
                  errorClass: "recovery_required",
                  terminalAt: now().getTime(),
                }).catch(() => forceRecoveryRequired(job));
              });
            }
            activeControllers.delete(job.operationId);
            active -= 1;
          }
        },
        async (error) => {
          clearTimeout(timer);
          try {
            if (stickyRecoveryRequired.has(job.operationId)) {
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                "error",
                startedAt,
                "recovery_required",
              );
            } else {
              const classification = timedOut
                ? { errorClass: "timeout" as const }
                : classify(error);
              await transition(job, timedOut ? "timed_out" : "failed", {
                result: undefined,
                errorClass: classification.errorClass,
                terminalAt: now().getTime(),
              });
              terminalDurable = true;
              audit(
                job.role,
                job.operation.kind,
                job.resourceId,
                timedOut ? "terminated" : "error",
                startedAt,
                classification.errorClass,
              );
            }
          } catch {
            await transition(job, "failed", {
              result: undefined,
              errorClass: "runtime",
              terminalAt: now().getTime(),
            })
              .then(() => {
                terminalDurable = true;
              })
              .catch(() => forceRecoveryRequired(job));
          } finally {
            if (terminalDurable) {
              await claimAdmission?.release().catch(async () => {
                stickyRecoveryRequired.add(job.operationId);
                await transition(job, "failed", {
                  result: undefined,
                  errorClass: "recovery_required",
                  terminalAt: now().getTime(),
                }).catch(() => forceRecoveryRequired(job));
              });
            }
            activeControllers.delete(job.operationId);
            active -= 1;
          }
        },
      );
    activeSettlements.set(job.operationId, settlement);
    void settlement.then(
      () => activeSettlements.delete(job.operationId),
      () => activeSettlements.delete(job.operationId),
    );
  };

  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode === 413 ? 413 : 400;
    return reply
      .code(statusCode)
      .send(redactedOpsError(requestIdFromBody(request.body), "validation", error));
  });
  app.get("/health", async () => ({ ok: true }));

  app.post("/v1/operations", async (request, reply) => {
    const startedAt = Date.now();
    const requestId = requestIdFromBody(request.body);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    let kind = operationKindFromBody(request.body);
    let resourceId: string = kind;
    try {
      const parsed = parseOpsRequest(request.body, { role });
      const operation = immutableSnapshot(parsed.operation);
      kind = operation.kind;
      resourceId = opsResourceId(operation);
      const nowMs = now().getTime();
      const timing = validateTiming(parsed.issuedAt, parsed.expiresAt, nowMs);
      replay.accept(parsed.requestId, timing.expiresAtMs, nowMs);
      const policy = OPS_KIND_POLICIES[operation.kind];
      const fingerprint = opsOperationFingerprint(operation);
      if (policy.execution === "async") {
        await pruneJobs(nowMs);
        const ownerKey = `${role}:${parsed.operationKey}`;
        const existing = jobsByKey.get(ownerKey);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new RequestGuardError("conflict", 409);
          return reply.code(202).send(
            opsSuccess(parsed.requestId, {
              execution: "async",
              operationId: existing.operationId,
              operationKey: existing.operationKey,
              kind: existing.operation.kind,
              state: existing.state,
            }),
          );
        }
        if (jobsById.size >= maxJobEntries) {
          throw new RequestGuardError("busy", 429);
        }
      }
      if (active >= maxConcurrency) throw new RequestGuardError("busy", 429);
      active += 1;
      const claimController = new AbortController();
      const claimExecution = Promise.resolve().then(() =>
        resourceClaimer.claim(operation, fingerprint, claimController.signal, {
          role,
          operationKey: parsed.operationKey,
        }),
      );
      let claimTimer: ReturnType<typeof setTimeout> | undefined;
      let claim: Awaited<ReturnType<OpsResourceClaimer["claim"]>>;
      try {
        claim = await Promise.race([
          claimExecution,
          new Promise<never>((_resolve, reject) => {
            claimTimer = setTimeout(() => {
              claimController.abort();
              reject(new RequestGuardError("timeout", 504));
            }, options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS);
          }),
        ]);
        if (claimTimer !== undefined) clearTimeout(claimTimer);
      } catch (error) {
        if (claimTimer !== undefined) clearTimeout(claimTimer);
        if (error instanceof RequestGuardError && error.errorClass === "timeout") {
          void claimExecution.then(
            (lateClaim) => {
              void lateClaim?.admission?.rollback().catch(() => undefined);
              active -= 1;
              audit(role, kind, resourceId, "late_completion", startedAt, "timeout");
            },
            () => {
              active -= 1;
              audit(role, kind, resourceId, "terminated", startedAt, "timeout");
            },
          );
          audit(role, kind, resourceId, "timeout", startedAt, "timeout");
          return reply.code(504).send(redactedOpsError(parsed.requestId, "timeout"));
        }
        active -= 1;
        throw error;
      }
      let claimAdmission: OpsTrustedClaim["admission"];
      try {
        if (
          !claim ||
          claim.fingerprint !== fingerprint ||
          opsOperationFingerprint(claim.operation as OpsOperation) !== fingerprint ||
          !claim.capability ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(claim.capability.revisionId) ||
          !claim.capability.values ||
          typeof claim.capability.values !== "object" ||
          Array.isArray(claim.capability.values) ||
          Object.keys(claim.capability.values).length > 64 ||
          Object.entries(claim.capability.values).some(
            ([key, value]) =>
              !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key) ||
              (value !== null && !["string", "number", "boolean"].includes(typeof value)) ||
              (typeof value === "number" && !Number.isFinite(value)),
          ) ||
          Buffer.byteLength(JSON.stringify(claim.capability), "utf8") > 512 * 1024
        ) {
          throw new OpsContractError("authorization", "Operation resource is not permitted");
        }
        claimAdmission = claim.admission;
        claim = immutableSnapshot({
          fingerprint: claim.fingerprint,
          operation: claim.operation,
          source: claim.source,
          capability: claim.capability,
        });
      } catch {
        await claim?.admission?.rollback().catch(() => undefined);
        active -= 1;
        throw new OpsContractError("authorization", "Operation resource is not permitted");
      }

      if (policy.execution === "async") {
        const ownerKey = `${role}:${parsed.operationKey}`;
        const admission = await withAdmissionLock(async () => {
          const retained = jobsByKey.get(ownerKey);
          if (retained) {
            if (retained.fingerprint !== fingerprint) {
              throw new RequestGuardError("conflict", 409);
            }
            return { type: "retained", job: retained } as const;
          }
          if (jobsById.size >= maxJobEntries) throw new RequestGuardError("busy", 429);
          const timestamp = now().toISOString();
          let operationId: string | undefined;
          try {
            for (let attempt = 0; attempt < MAX_JOB_ID_ATTEMPTS; attempt += 1) {
              const candidate = `job1_${Buffer.from(randomBytes(18)).toString("base64url")}`;
              if (OPERATION_ID_PATTERN.test(candidate) && !jobsById.has(candidate)) {
                operationId = candidate;
                break;
              }
            }
          } catch {
            throw new RequestGuardError("runtime", 500);
          }
          if (!operationId) throw new RequestGuardError("busy", 429);
          const job: JobRecord = {
            role,
            operation,
            operationId,
            operationKey: parsed.operationKey,
            fingerprint,
            resourceId,
            state: "queued",
            submittedAt: timestamp,
            updatedAt: timestamp,
            cursor: 0,
            events: [],
            eventBytes: 0,
            eventsTruncated: false,
          };
          await journal.replace([...jobsById.values()].map(persisted).concat(persisted(job)));
          jobsById.set(job.operationId, job);
          jobsByKey.set(ownerKey, job);
          return { type: "new", job } as const;
        }).catch(async (error) => {
          await claimAdmission?.rollback().catch(() => undefined);
          active -= 1;
          throw error instanceof RequestGuardError ? error : new RequestGuardError("runtime", 500);
        });
        if (admission.type === "retained") {
          await claimAdmission?.rollback().catch(() => undefined);
          active -= 1;
          return reply.code(202).send(
            opsSuccess(parsed.requestId, {
              execution: "async",
              operationId: admission.job.operationId,
              operationKey: admission.job.operationKey,
              kind: admission.job.operation.kind,
              state: admission.job.state,
            }),
          );
        }
        const { job } = admission;
        try {
          await claimAdmission?.commit();
        } catch {
          stickyRecoveryRequired.add(job.operationId);
          await transition(job, "failed", {
            result: undefined,
            errorClass: "recovery_required",
            terminalAt: now().getTime(),
          }).catch(() => forceRecoveryRequired(job));
          await claimAdmission?.release().catch(() => undefined);
          active -= 1;
          throw new RequestGuardError("runtime", 500);
        }
        await runAsync(job, startedAt, claim, claimAdmission);
        return reply.code(202).send(
          opsSuccess(parsed.requestId, {
            execution: "async",
            operationId: job.operationId,
            operationKey: job.operationKey,
            kind: job.operation.kind,
            state: job.state,
          }),
        );
      }
      const controller = new AbortController();
      try {
        await claimAdmission?.commit();
      } catch {
        active -= 1;
        throw new RequestGuardError("runtime", 500);
      }
      const timeoutMs = Math.min(
        policy.timeoutMs,
        options.operationTimeoutMs ?? Number.POSITIVE_INFINITY,
      );
      const execution = Promise.resolve().then(() =>
        dispatch(operation, runtime, {
          signal: controller.signal,
          emitLog: () => undefined,
          claim,
        }),
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutResult = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new RequestGuardError("timeout", 504));
          }, timeoutMs);
        });
        const rawResult = await Promise.race([execution, timeoutResult]);
        clearTimeout(timeout);
        const value = parseBoundedOpsResult(operation.kind, rawResult);
        audit(role, kind, resourceId, "success", startedAt);
        const envelope = opsSuccess(parsed.requestId, { execution: "sync", kind, value });
        if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > OPS_MAX_HTTP_RESPONSE_BYTES) {
          throw new RequestGuardError("runtime", 500);
        }
        active -= 1;
        return reply.code(200).send(envelope);
      } catch (error) {
        if (timeout !== undefined) clearTimeout(timeout);
        if (error instanceof RequestGuardError && error.errorClass === "timeout") {
          void execution.then(
            () => {
              active -= 1;
              audit(role, kind, resourceId, "late_completion", startedAt, "timeout");
            },
            () => {
              active -= 1;
              audit(role, kind, resourceId, "terminated", startedAt, "timeout");
            },
          );
          audit(role, kind, resourceId, "timeout", startedAt, "timeout");
          return reply.code(504).send(redactedOpsError(parsed.requestId, "timeout"));
        }
        active -= 1;
        throw error;
      }
    } catch (error) {
      const classification = classify(error);
      audit(
        role,
        kind,
        resourceId,
        classification.errorClass === "authorization" ? "denied" : "error",
        startedAt,
        classification.errorClass,
      );
      return reply
        .code(classification.statusCode)
        .send(redactedOpsError(requestId, classification.errorClass, error));
    }
  });

  app.get("/v1/operation-keys/:operationKey", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    const operationKey = (request.params as { operationKey?: unknown }).operationKey;
    if (typeof operationKey !== "string" || !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(operationKey)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsByKey.get(`${role}:${operationKey}`);
    if (!job) return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    const fingerprint = request.headers["x-ops-operation-fingerprint"];
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    if (fingerprint !== job.fingerprint) {
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    }
    return reply.code(200).send(opsSuccess(requestId, statusFor(job)));
  });

  app.get("/v1/operations/:operationId", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsById.get(operationId);
    if (!job || job.role !== role) {
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    }
    return reply.code(200).send(opsSuccess(requestId, statusFor(job)));
  });

  app.delete("/v1/operations/:operationId", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsById.get(operationId);
    if (!job || job.role !== role) {
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    }
    if (job.terminalAt !== undefined) {
      return reply.code(200).send(opsSuccess(requestId, statusFor(job)));
    }
    const controller = activeControllers.get(operationId);
    if (!controller) {
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    }
    try {
      await withAdmissionLock(async () => {
        if (job.terminalAt !== undefined || job.state === "termination_pending") return;
        const updatedAt = now().toISOString();
        const candidate: JobRecord = {
          ...job,
          state: "termination_pending",
          updatedAt,
          terminationRequestedAt: job.terminationRequestedAt ?? updatedAt,
        };
        await journal.replace(
          [...jobsById.values()].map((entry) => persisted(entry === job ? candidate : entry)),
        );
        job.state = "termination_pending";
        job.updatedAt = updatedAt;
        job.terminationRequestedAt = candidate.terminationRequestedAt;
        job.cursor += 1;
        pushEvent(job, { cursor: job.cursor, type: "state", state: "termination_pending" });
      });
    } catch {
      forceRecoveryRequired(job);
      controller.abort();
      return reply.code(500).send(redactedOpsError(requestId, "runtime"));
    }
    controller.abort();
    const settlement = activeSettlements.get(operationId);
    if (settlement) {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        settlement,
        new Promise<void>((resolve) => {
          waitTimer = setTimeout(resolve, 5_000);
        }),
      ]).finally(() => {
        if (waitTimer !== undefined) clearTimeout(waitTimer);
      });
    }
    return reply.code(200).send(opsSuccess(requestId, statusFor(job)));
  });

  app.get("/v1/operations/:operationId/events", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    const query = request.query as { after?: unknown; limit?: unknown };
    const after = Number(query.after ?? 0);
    const limit = Number(query.limit ?? OPS_MAX_EVENT_BATCH);
    if (
      typeof operationId !== "string" ||
      !OPERATION_ID_PATTERN.test(operationId) ||
      !Number.isInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > OPS_MAX_EVENT_BATCH
    ) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await pruneJobs(now().getTime());
    const job = jobsById.get(operationId);
    if (!job || job.role !== role) {
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    }
    const events = job.events.filter((event) => event.cursor > after).slice(0, limit);
    return reply.code(200).send(
      opsSuccess(requestId, {
        version: 1,
        operationId,
        nextCursor: events.at(-1)?.cursor ?? after,
        terminal: job.terminalAt !== undefined,
        truncated: job.eventsTruncated,
        events,
      }),
    );
  });
  return app;
}
