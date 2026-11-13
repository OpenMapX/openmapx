import { randomUUID } from "node:crypto";
import {
  ACTIVE_REQUEST_STATES,
  acceptsCaseDecision,
  acceptsManualIdentityVerification,
  acceptsSelfServiceExport,
  acceptsTaskResolution,
  canExtendDeadline,
  INITIAL_REQUEST_STATE,
  isTerminalRequestState,
} from "@openmapx/core/privacy";
import { defaultLocale, resolveLocale } from "@openmapx/i18n";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import type { PrivacyNotificationTemplate, RequestState } from "../db/privacy-schema.js";
import {
  dataSubjectRequest,
  dataSubjectRequestEvent,
  dataSubjectRequestNotification,
  dataSubjectRequestPreservation,
  dataSubjectRequestTask,
  user,
} from "../db/schema.js";
import { decrypt, encrypt } from "../services/secrets.js";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import { addCalendarMonths, calculateSubjectRequestDueAt } from "./deadline.js";
import { PrivacyRequestError } from "./errors.js";
import { findIdempotentEvent, idempotencyFingerprint } from "./idempotency.js";
import { withPreservationRetentionLock } from "./preservation.js";
import {
  assertValidRequestTransition,
  type CreateSubjectRequestInput,
  createSubjectRequestSchema,
  eventPayloadSchema,
} from "./request-contracts.js";

export interface PrivacyRequestServiceOptions {
  database?: typeof defaultDb;
  catalogue?: typeof SUBJECT_DATA_CATALOGUE;
  now?: () => Date;
}

type RequestRow = typeof dataSubjectRequest.$inferSelect;
type Transaction = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];
type Actor = { kind: "subject" | "admin" | "system"; id?: string | null };

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/;
const REASON_CODE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Subject templates sent when a request enters a state. */
const STATE_TEMPLATES: Partial<Record<RequestState, PrivacyNotificationTemplate>> = {
  waiting_on_requester: "waiting_on_requester",
  completed: "completed",
  refused: "refused",
};
const NOTIFICATION_TARGET = [
  dataSubjectRequestNotification.requestId,
  dataSubjectRequestNotification.template,
  dataSubjectRequestNotification.channel,
  dataSubjectRequestNotification.recipientUserId,
];

function toDate(value: Date | string | number): Date {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(result.getTime())) throw new PrivacyRequestError("INVALID_DATE", 400);
  return result;
}

function boundedEventPayload(payload: Record<string, unknown> = {}): Record<string, unknown> {
  const parsed = eventPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PrivacyRequestError("INVALID_EVENT_PAYLOAD", 400);
  return parsed.data;
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !IDEMPOTENCY_KEY.test(value))
    throw new PrivacyRequestError("IDEMPOTENCY_KEY_REQUIRED", 400);
  return value;
}

function requireReasonCode(value: string): string {
  if (!REASON_CODE.test(value)) throw new PrivacyRequestError("INVALID_REASON", 400);
  return value;
}

function notificationValues(input: {
  requestId: string;
  recipientUserId: string;
  template: PrivacyNotificationTemplate;
  locale: string;
  at: Date;
}) {
  return {
    requestId: input.requestId,
    recipientUserId: input.recipientUserId,
    template: input.template,
    channel: "email" as const,
    locale: resolveLocale(input.locale),
    payload: {},
    state: "pending" as const,
    attempts: 0,
    nextAttemptAt: input.at,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

function encodeLocator(value: string): string {
  return JSON.stringify(encrypt(JSON.stringify({ value })));
}

/** A stored locator that cannot be decrypted (for example after a changed
 * OPENMAPX_SECRETS_KEY) is an operational failure, never "no subject". */
function decodeLocator(envelope: string): string {
  let value: unknown;
  try {
    const parsed = JSON.parse(envelope) as { ciphertext: string; iv: string; tag: string };
    value = (JSON.parse(decrypt(parsed.ciphertext, parsed.iv, parsed.tag)) as { value?: unknown })
      .value;
  } catch {
    throw new PrivacyRequestError("SUBJECT_LOCATOR_UNREADABLE", 503);
  }
  if (typeof value !== "string" || !value)
    throw new PrivacyRequestError("SUBJECT_LOCATOR_UNREADABLE", 503);
  return value;
}

/** Active administrator accounts that receive operator alerts. */
export async function privacyAlertRecipients(
  database: Pick<typeof defaultDb, "select">,
  now: Date,
): Promise<string[]> {
  const rows = await database
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.role, "admin"),
        or(isNull(user.banned), eq(user.banned, false), lte(user.banExpires, now)),
        sql`${user.id} <> 'loopback'`,
      ),
    );
  return rows.map((row) => row.id);
}

export class PrivacyRequestService {
  private readonly database: typeof defaultDb;
  private readonly catalogue: typeof SUBJECT_DATA_CATALOGUE;
  private readonly now: () => Date;

  constructor(options: PrivacyRequestServiceOptions = {}) {
    this.database = options.database ?? defaultDb;
    this.catalogue = options.catalogue ?? SUBJECT_DATA_CATALOGUE;
    this.now = options.now ?? (() => new Date());
  }

  /** The exact account whose data an export contains, or null when an
   * assisted case names someone only by email or another reference. */
  subjectUserId(request: Pick<RequestRow, "userId" | "locatorType" | "encryptedLocator">) {
    if (request.userId) return request.userId;
    if (request.locatorType !== "user_id" || !request.encryptedLocator) return null;
    return decodeLocator(request.encryptedLocator);
  }

  private async activeRequestFor(userId: string, kind: RequestRow["kind"]) {
    const rows = await this.database
      .select()
      .from(dataSubjectRequest)
      .where(
        and(
          eq(dataSubjectRequest.userId, userId),
          eq(dataSubjectRequest.kind, kind),
          inArray(dataSubjectRequest.state, [...ACTIVE_REQUEST_STATES]),
        ),
      )
      .orderBy(desc(dataSubjectRequest.createdAt))
      .limit(1);
    return rows[0];
  }

  async create(input: CreateSubjectRequestInput): Promise<RequestRow> {
    const parsed = createSubjectRequestSchema.parse(input);
    const now = this.now();
    const requestedReceivedAt = parsed.receivedAt ? toDate(parsed.receivedAt) : now;
    const selfService = parsed.channel === "self_service";
    if (selfService && Math.abs(now.getTime() - requestedReceivedAt.getTime()) > 5 * 60_000)
      throw new PrivacyRequestError("RECEIPT_TIME_MUST_BE_CURRENT", 400);
    const receivedAt = selfService ? now : requestedReceivedAt;
    if (parsed.userId) {
      const existing = await this.activeRequestFor(parsed.userId, parsed.kind);
      if (existing) return existing;
    }
    const id = randomUUID();
    const locatorType = parsed.subject?.locatorType ?? "user_id";
    const locatorValue = parsed.subject?.locator ?? parsed.userId;
    if (!locatorValue) throw new PrivacyRequestError("SUBJECT_LOCATOR_REQUIRED", 400);
    // An assisted request keeps how the person was named; a self-service
    // request is tied to the signed-in account and needs no locator copy.
    const encryptedLocator = selfService ? null : encodeLocator(locatorValue);
    const applicable = this.catalogue.filter(
      (registration) => registration.strategy !== "not_personal",
    );
    try {
      await withPreservationRetentionLock(this.database, async (tx) => {
        const [created] = await tx
          .insert(dataSubjectRequest)
          .values({
            id,
            kind: parsed.kind,
            channel: parsed.channel,
            userId: parsed.userId,
            actorUserId: parsed.actorUserId ?? null,
            actorSessionId: parsed.actorSessionId ?? null,
            encryptedLocator,
            locatorType,
            accountState: parsed.subject?.accountState ?? "current",
            locale: parsed.locale,
            timeZone: parsed.timeZone,
            state: INITIAL_REQUEST_STATE,
            version: 1,
            receivedAt,
            registeredAt: now,
            preservationAt: now,
            snapshotAt: now,
            dueAt: calculateSubjectRequestDueAt(receivedAt, parsed.timeZone),
            extension: null,
            identityMethod: selfService ? "account_session" : null,
            identityVerifiedAt: selfService ? now : null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!created) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 500);
        await tx.insert(dataSubjectRequestEvent).values({
          id: randomUUID(),
          requestId: id,
          eventType: "received",
          actorKind: selfService ? "subject" : "admin",
          actorId: parsed.actorUserId ?? null,
          payload: boundedEventPayload({ kind: parsed.kind, channel: parsed.channel }),
          payloadVersion: 1,
          ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
          createdAt: now,
        });
        if (parsed.userId)
          await tx
            .insert(dataSubjectRequestNotification)
            .values(
              notificationValues({
                requestId: id,
                recipientUserId: parsed.userId,
                template: "acknowledgement",
                locale: parsed.locale,
                at: now,
              }),
            )
            .onConflictDoNothing({ target: NOTIFICATION_TARGET });
        // Every new request alerts each administrator, so an assisted request
        // without a subject account and a self-service download that still
        // waits on operator-held sources are both seen.
        const admins = await privacyAlertRecipients(tx, now);
        if (admins.length)
          await tx
            .insert(dataSubjectRequestNotification)
            .values(
              admins.map((recipientUserId) =>
                notificationValues({
                  requestId: id,
                  recipientUserId,
                  template: "admin_new_request",
                  locale: defaultLocale,
                  at: now,
                }),
              ),
            )
            .onConflictDoNothing({ target: NOTIFICATION_TARGET });
        for (const registration of applicable) {
          const operatorTask = registration.strategy === "operator_task";
          const publicCode = `${registration.source}-preservation-action-required`;
          if (operatorTask)
            await tx.insert(dataSubjectRequestTask).values({
              id: randomUUID(),
              requestId: id,
              registrationId: registration.id,
              source: registration.source,
              status: "open",
              publicCode,
              createdAt: now,
              updatedAt: now,
            });
          await tx.insert(dataSubjectRequestPreservation).values({
            id: randomUUID(),
            requestId: id,
            registrationId: registration.id,
            sourceCutoffAt: now,
            startedAt: now,
            ...(operatorTask
              ? { status: "action_required", outcomeCode: publicCode }
              : registration.source === "managed-service"
                ? {
                    status: "source_capture_pending",
                    outcomeCode: "managed-source-capture-required",
                  }
                : { status: "held" }),
          });
        }
        // The signed-in session already proves who asks, so self-service work
        // starts at once.
        if (selfService)
          await this.applyTransition(tx, created, {
            to: "in_progress",
            actor: { kind: "subject", id: parsed.userId },
            reasonCode: "account-session",
          });
      });
    } catch (error: unknown) {
      // The partial unique index decides a race between two first requests:
      // the loser returns the winner's active case.
      if (parsed.userId && String(error).includes("data_subject_request_active_user_kind_idx")) {
        const raced = await this.activeRequestFor(parsed.userId, parsed.kind);
        if (raced) return raced;
        throw new PrivacyRequestError("REQUEST_ALREADY_ACTIVE", 409);
      }
      throw error;
    }
    return this.getById(id);
  }

  async getById(requestId: string): Promise<RequestRow> {
    const rows = await this.database
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, requestId))
      .limit(1);
    if (!rows[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
    return rows[0];
  }

  async listForUser(userId: string): Promise<ReadonlyArray<RequestRow>> {
    return this.database
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.userId, userId))
      .orderBy(desc(dataSubjectRequest.createdAt));
  }

  async getForUser(requestId: string, userId: string): Promise<RequestRow> {
    const rows = await this.database
      .select()
      .from(dataSubjectRequest)
      .where(and(eq(dataSubjectRequest.id, requestId), eq(dataSubjectRequest.userId, userId)))
      .limit(1);
    if (!rows[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
    return rows[0];
  }

  async openTaskCount(requestId: string): Promise<number> {
    const rows = await this.database
      .select({ id: dataSubjectRequestTask.id })
      .from(dataSubjectRequestTask)
      .where(
        and(
          eq(dataSubjectRequestTask.requestId, requestId),
          eq(dataSubjectRequestTask.status, "open"),
        ),
      );
    return rows.length;
  }

  /**
   * The single writer of request state. It checks the transition table, bumps
   * the version only when the caller's version still matches, records the
   * event, queues the subject notification and releases retention holds when
   * the request closes.
   */
  private async applyTransition(
    tx: Transaction,
    current: RequestRow,
    input: {
      to: RequestState;
      actor: Actor;
      reasonCode?: string;
      idempotencyKey?: string;
      operationDigest?: string;
      set?: Partial<typeof dataSubjectRequest.$inferInsert>;
    },
  ): Promise<RequestRow> {
    assertValidRequestTransition(current.state, input.to);
    const now = this.now();
    const closing = isTerminalRequestState(input.to);
    const [updated] = await tx
      .update(dataSubjectRequest)
      .set({
        ...input.set,
        state: input.to,
        version: sql`${dataSubjectRequest.version} + 1`,
        updatedAt: now,
        ...(input.to === "refused" ? { refusalCode: input.reasonCode ?? null } : {}),
        ...(input.to === "completed" ? { completedAt: now } : {}),
        ...(closing ? { closedAt: now } : {}),
      })
      .where(
        and(
          eq(dataSubjectRequest.id, current.id),
          eq(dataSubjectRequest.state, current.state),
          eq(dataSubjectRequest.version, current.version),
        ),
      )
      .returning();
    if (!updated) throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
    await tx.insert(dataSubjectRequestEvent).values({
      id: randomUUID(),
      requestId: current.id,
      eventType: `state_${input.to}`,
      actorKind: input.actor.kind,
      actorId: input.actor.id ? input.actor.id.slice(0, 256) : null,
      payload: boundedEventPayload({
        from: current.state,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.operationDigest ? { operationDigest: input.operationDigest } : {}),
      }),
      payloadVersion: 1,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      createdAt: now,
    });
    const template = STATE_TEMPLATES[input.to];
    // A withdrawal is the subject's own act; it needs no completion email.
    if (template && updated.userId && input.reasonCode !== "withdrawn")
      await tx
        .insert(dataSubjectRequestNotification)
        .values(
          notificationValues({
            requestId: current.id,
            recipientUserId: updated.userId,
            template,
            locale: updated.locale,
            at: now,
          }),
        )
        .onConflictDoNothing({ target: NOTIFICATION_TARGET });
    if (closing)
      await tx
        .update(dataSubjectRequestPreservation)
        .set({ releasedAt: now, status: "released" })
        .where(
          and(
            eq(dataSubjectRequestPreservation.requestId, current.id),
            isNull(dataSubjectRequestPreservation.releasedAt),
          ),
        );
    return updated;
  }

  /**
   * Run one versioned, idempotent mutation on a locked request row. A replay
   * with the same key and the same operation returns the current row; a key
   * reused for a different operation is refused.
   */
  private async mutate(
    input: {
      requestId: string;
      version: number;
      idempotencyKey: string;
      eventType: string;
      operationDigest: string;
    },
    work: (tx: Transaction, current: RequestRow) => Promise<RequestRow>,
  ): Promise<RequestRow> {
    requireIdempotencyKey(input.idempotencyKey);
    try {
      return await this.database.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(dataSubjectRequest)
          .where(eq(dataSubjectRequest.id, input.requestId))
          .for("update")
          .limit(1);
        if (!current) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
        const previous = await findIdempotentEvent(tx as unknown as typeof defaultDb, {
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          eventType: input.eventType,
          operationDigest: input.operationDigest,
        });
        if (previous) return current;
        if (current.version !== input.version)
          throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
        return work(tx, current);
      });
    } catch (error) {
      if (String(error).includes("data_subject_request_event_idempotency_idx"))
        return this.getById(input.requestId);
      throw error;
    }
  }

  /** The subject withdraws: the request completes with reason `withdrawn`. */
  async withdraw(
    requestId: string,
    userId: string,
    version: number,
    idempotencyKey: string,
  ): Promise<RequestRow> {
    await this.getForUser(requestId, userId);
    const operationDigest = idempotencyFingerprint({
      requestId,
      userId,
      version,
      action: "withdraw",
    });
    return this.mutate(
      { requestId, version, idempotencyKey, eventType: "state_completed", operationDigest },
      (tx, current) =>
        this.applyTransition(tx, current, {
          to: "completed",
          actor: { kind: "subject", id: userId },
          reasonCode: "withdrawn",
          idempotencyKey,
          operationDigest,
        }),
    );
  }

  /** Record an operator's manual identity check and start the work. */
  async verifyIdentity(input: {
    requestId: string;
    version: number;
    reasonCode: string;
    actorId: string;
    idempotencyKey: string;
  }): Promise<RequestRow> {
    const reasonCode = requireReasonCode(input.reasonCode);
    const operationDigest = idempotencyFingerprint({
      version: input.version,
      reasonCode,
      actorId: input.actorId,
      action: "verify-identity",
    });
    return this.mutate(
      { ...input, eventType: "state_in_progress", operationDigest },
      async (tx, current) => {
        if (current.identityMethod || !acceptsManualIdentityVerification(current.state))
          throw new PrivacyRequestError("IDENTITY_VERIFICATION_NOT_ALLOWED", 409);
        return this.applyTransition(tx, current, {
          to: "in_progress",
          actor: { kind: "admin", id: input.actorId },
          reasonCode,
          idempotencyKey: input.idempotencyKey,
          operationDigest,
          set: { identityMethod: "manual", identityVerifiedAt: this.now() },
        });
      },
    );
  }

  async recordDecision(input: {
    requestId: string;
    version: number;
    decision: "in_progress" | "waiting_on_requester" | "completed" | "refused";
    reasonCode: string;
    actorId: string;
    idempotencyKey: string;
  }): Promise<RequestRow> {
    const reasonCode = requireReasonCode(input.reasonCode);
    const operationDigest = idempotencyFingerprint({
      version: input.version,
      decision: input.decision,
      reasonCode,
      actorId: input.actorId,
    });
    return this.mutate(
      { ...input, eventType: `state_${input.decision}`, operationDigest },
      async (tx, current) => {
        if (!acceptsCaseDecision(current.state))
          throw new PrivacyRequestError("CASE_DECISION_NOT_ALLOWED", 409);
        // Work on a case starts only once the requester's identity is known.
        if (input.decision === "in_progress" && !current.identityMethod)
          throw new PrivacyRequestError("IDENTITY_REQUIRED", 409);
        if (input.decision === "completed") {
          const [openTask] = await tx
            .select({ id: dataSubjectRequestTask.id })
            .from(dataSubjectRequestTask)
            .where(
              and(
                eq(dataSubjectRequestTask.requestId, current.id),
                eq(dataSubjectRequestTask.status, "open"),
              ),
            )
            .limit(1);
          if (openTask) throw new PrivacyRequestError("TASKS_UNRESOLVED", 409);
        }
        return this.applyTransition(tx, current, {
          to: input.decision,
          actor: { kind: "admin", id: input.actorId },
          reasonCode,
          idempotencyKey: input.idempotencyKey,
          operationDigest,
        });
      },
    );
  }

  /** Resolve one operator-held source with a reason code. */
  async resolveTask(input: {
    requestId: string;
    taskId: string;
    version: number;
    reasonCode: string;
    actorId: string;
    idempotencyKey: string;
  }): Promise<RequestRow> {
    const reasonCode = requireReasonCode(input.reasonCode);
    const operationDigest = idempotencyFingerprint({
      taskId: input.taskId,
      version: input.version,
      reasonCode,
      actorId: input.actorId,
    });
    return this.mutate(
      { ...input, eventType: "task_resolved", operationDigest },
      async (tx, current) => {
        if (!acceptsTaskResolution(current.state))
          throw new PrivacyRequestError("TASK_RESOLUTION_NOT_ALLOWED", 409);
        const now = this.now();
        const [task] = await tx
          .update(dataSubjectRequestTask)
          .set({ status: "resolved", resolutionCode: reasonCode, resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(dataSubjectRequestTask.id, input.taskId),
              eq(dataSubjectRequestTask.requestId, current.id),
              eq(dataSubjectRequestTask.status, "open"),
            ),
          )
          .returning({ id: dataSubjectRequestTask.id });
        if (!task) throw new PrivacyRequestError("TASK_NOT_FOUND", 404);
        const [updated] = await tx
          .update(dataSubjectRequest)
          .set({ version: sql`${dataSubjectRequest.version} + 1`, updatedAt: now })
          .where(eq(dataSubjectRequest.id, current.id))
          .returning();
        if (!updated) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
        await tx.insert(dataSubjectRequestEvent).values({
          id: randomUUID(),
          requestId: current.id,
          eventType: "task_resolved",
          actorKind: "admin",
          actorId: input.actorId,
          payload: boundedEventPayload({ taskId: input.taskId, reasonCode, operationDigest }),
          payloadVersion: 1,
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
        });
        return updated;
      },
    );
  }

  async recordExtension(input: {
    requestId: string;
    version: number;
    extendedUntil: Date;
    extensionNotifiedAt: Date;
    reasonCode: string;
    actorId: string;
    idempotencyKey: string;
  }): Promise<RequestRow> {
    if (!REASON_CODE.test(input.reasonCode))
      throw new PrivacyRequestError("INVALID_EXTENSION_REASON", 400);
    const extendedUntil = toDate(input.extendedUntil),
      notifiedAt = toDate(input.extensionNotifiedAt);
    const operationDigest = idempotencyFingerprint({
      version: input.version,
      extendedUntil: extendedUntil.toISOString(),
      extensionNotifiedAt: notifiedAt.toISOString(),
      reasonCode: input.reasonCode,
      actorId: input.actorId,
    });
    return this.mutate(
      { ...input, eventType: "extended", operationDigest },
      async (tx, current) => {
        const now = this.now();
        if (!canExtendDeadline(current.state))
          throw new PrivacyRequestError("EXTENSION_NOT_ALLOWED", 409);
        const originalDueAt = calculateSubjectRequestDueAt(current.receivedAt, current.timeZone);
        const max = addCalendarMonths(originalDueAt, 2, current.timeZone);
        if (
          extendedUntil <= current.dueAt ||
          extendedUntil > max ||
          notifiedAt > originalDueAt ||
          notifiedAt > now ||
          notifiedAt < current.receivedAt
        )
          throw new PrivacyRequestError("INVALID_EXTENSION", 400);
        const [updated] = await tx
          .update(dataSubjectRequest)
          .set({
            extension: {
              extendedUntil: extendedUntil.toISOString(),
              extensionNotifiedAt: notifiedAt.toISOString(),
              reasonCode: input.reasonCode,
            },
            dueAt: extendedUntil,
            version: sql`${dataSubjectRequest.version} + 1`,
            updatedAt: now,
          })
          .where(eq(dataSubjectRequest.id, current.id))
          .returning();
        if (!updated) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
        await tx.insert(dataSubjectRequestEvent).values({
          id: randomUUID(),
          requestId: current.id,
          eventType: "extended",
          actorKind: "admin",
          actorId: input.actorId,
          payload: boundedEventPayload({ reasonCode: input.reasonCode, operationDigest }),
          payloadVersion: 1,
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
        });
        if (updated.userId)
          await tx
            .insert(dataSubjectRequestNotification)
            .values(
              notificationValues({
                requestId: current.id,
                recipientUserId: updated.userId,
                template: "extension",
                locale: updated.locale,
                at: now,
              }),
            )
            .onConflictDoNothing({ target: NOTIFICATION_TARGET });
        return updated;
      },
    );
  }

  /**
   * Create or reuse the subject's active request and mark the start of one
   * export. The freshly signed-in session is the identity proof: an assisted
   * case linked to this account that is still unverified is verified by it.
   * A request that is open or waiting on the requester returns to work,
   * because downloading is the requester acting.
   */
  async beginSelfServiceExport(input: {
    userId: string;
    sessionId: string;
    kind: RequestRow["kind"];
    locale: string;
    timeZone: string;
  }): Promise<RequestRow> {
    let request = await this.create({
      kind: input.kind,
      channel: "self_service",
      userId: input.userId,
      actorUserId: input.userId,
      actorSessionId: input.sessionId,
      locale: input.locale,
      timeZone: input.timeZone,
    });
    if (!acceptsSelfServiceExport(request.state))
      throw new PrivacyRequestError("REQUEST_NOT_ACTIVE", 409);
    if (request.state !== "in_progress") {
      const current = request;
      const verifying = !current.identityMethod;
      const now = this.now();
      request = await this.database.transaction(async (tx) => {
        if (verifying)
          await tx.insert(dataSubjectRequestEvent).values({
            id: randomUUID(),
            requestId: current.id,
            eventType: "identity_verified",
            actorKind: "subject",
            actorId: input.userId,
            payload: boundedEventPayload({ reasonCode: "account_session" }),
            payloadVersion: 1,
            createdAt: now,
          });
        return this.applyTransition(tx, current, {
          to: "in_progress",
          actor: { kind: "subject", id: input.userId },
          reasonCode: verifying ? "account_session" : "export-requested",
          ...(verifying
            ? { set: { identityMethod: "account_session", identityVerifiedAt: now } }
            : {}),
        });
      });
    }
    return this.recordExportEvent(request, "export_started", {
      kind: "subject",
      id: input.userId,
    });
  }

  /** Mark the start of an administrator export for an assisted request. A
   * self-service request is downloaded by its subject, not by an administrator. */
  async beginAdminExport(requestId: string, actorId: string): Promise<RequestRow> {
    const request = await this.getById(requestId);
    if (request.channel === "self_service")
      throw new PrivacyRequestError("ASSISTED_REQUEST_REQUIRED", 409);
    if (!acceptsCaseDecision(request.state))
      throw new PrivacyRequestError("REQUEST_NOT_ACTIVE", 409);
    if (!request.identityMethod) throw new PrivacyRequestError("IDENTITY_REQUIRED", 409);
    return this.recordExportEvent(request, "export_started", { kind: "admin", id: actorId });
  }

  /**
   * Record that every byte of an export reached the client. A self-service
   * request completes when no operator-held source is still open; otherwise
   * it stays in progress for the administrator, who was alerted when the
   * request arrived.
   */
  async finishExport(requestId: string, actor: Actor): Promise<RequestRow> {
    const request = await this.recordExportEvent(
      await this.getById(requestId),
      "export_delivered",
      actor,
    );
    if (
      actor.kind !== "subject" ||
      request.state !== "in_progress" ||
      (await this.openTaskCount(requestId)) > 0
    )
      return request;
    return this.database.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, requestId))
        .for("update")
        .limit(1);
      if (!current || current.state !== "in_progress") return current ?? request;
      return this.applyTransition(tx, current, {
        to: "completed",
        actor,
        reasonCode: "export-delivered",
      });
    });
  }

  private async recordExportEvent(
    request: RequestRow,
    eventType: "export_started" | "export_delivered",
    actor: Actor,
  ): Promise<RequestRow> {
    const now = this.now();
    await this.database.insert(dataSubjectRequestEvent).values({
      id: randomUUID(),
      requestId: request.id,
      eventType,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      payload: {},
      payloadVersion: 1,
      createdAt: now,
    });
    if (eventType !== "export_started") return request;
    // The export is collected now, so the request records this snapshot time.
    const [updated] = await this.database
      .update(dataSubjectRequest)
      .set({ snapshotAt: now, updatedAt: now })
      .where(eq(dataSubjectRequest.id, request.id))
      .returning();
    return updated ?? request;
  }

  /** Record an export failure without identifiers in the payload. */
  async recordExportFailure(requestId: string, reasonCode: string): Promise<void> {
    await this.database.insert(dataSubjectRequestEvent).values({
      id: randomUUID(),
      requestId,
      eventType: "export_failed",
      actorKind: "system",
      actorId: "privacy-export",
      payloadVersion: 1,
      payload: { reasonCode: REASON_CODE.test(reasonCode) ? reasonCode : "export-failed" },
      createdAt: this.now(),
    });
  }
}
