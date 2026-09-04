import { createHmac, randomUUID } from "node:crypto";
import { envString } from "@openmapx/core/server-env";
import { resolveLocale } from "@openmapx/i18n";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import type { RequestState, TaskState } from "../db/privacy-schema.js";
import {
  dataExportArtifact,
  dataSubjectRequest,
  dataSubjectRequestAttachment,
  dataSubjectRequestEvent,
  dataSubjectRequestIdentity,
  dataSubjectRequestNotification,
  dataSubjectRequestPreservation,
  dataSubjectRequestTask,
  sessionAuthAssurance,
  user,
} from "../db/schema.js";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import {
  type CryptoEnvelope,
  decryptEnvelope,
  encryptEnvelope,
  loadMasterKeyRingAsync,
  type MasterKeyRing,
  makeAad,
} from "./crypto.js";
import { addCalendarMonths, calculateSubjectRequestDueAt } from "./deadline.js";
import { idempotencyFingerprint } from "./idempotency.js";
import { withPreservationRetentionLock } from "./preservation.js";
import {
  captureReceiptSourceSnapshots,
  type ReceiptPreservationDependencies,
} from "./receipt-snapshot.js";
import {
  assertAssemblyReady,
  assertValidRequestTransition,
  type CreateSubjectRequestInput,
  createSubjectRequestSchema,
  eventPayloadSchema,
  identityReviewSchema,
} from "./request-contracts.js";

/** Reviewed workflow contracts consumed by release readiness. Individual
 * requests still remain blocked until their own required tasks are resolved. */
export const PRIVACY_ASSISTED_WORKFLOW_CAPABILITY = Object.freeze({
  version: 1,
  authoritativeIdentityChallenge: true,
  representativeAuthorityReview: true,
  freshAuthenticatedDelivery: true,
});
export const PRIVACY_OPERATOR_TASK_WORKFLOW_CAPABILITY = Object.freeze({
  version: 1,
  immutableDecisionEvents: true,
  encryptedSupplements: true,
  generationRequiresResolvedTasks: true,
});

export class PrivacyRequestError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(code);
    this.name = "PrivacyRequestError";
  }
}

export interface PrivacyRequestServiceOptions {
  database?: typeof defaultDb;
  catalogue?: typeof SUBJECT_DATA_CATALOGUE;
  now?: () => Date;
  keyRing?: MasterKeyRing;
  keyRingPromise?: Promise<MasterKeyRing>;
  deploymentId?: string;
  enqueue?: (requestId: string) => void | Promise<void>;
  /** Physical ciphertext deletion is injected so DB mutations stay testable. */
  deleteArtifactStorage?: (storageKey: string) => Promise<void>;
  /** Present for every production intake path, even when a dependency is
   * unavailable, so receipt capture failures become explicit source tasks. */
  receiptPreservation?: ReceiptPreservationDependencies;
}

type DbLike = typeof defaultDb;
function actorPayload(actor: { kind: string; id?: string | null }): {
  actorKind: string;
  actorId: string | null;
} {
  return {
    actorKind: actor.kind.slice(0, 32),
    actorId: actor.id ? actor.id.slice(0, 256) : null,
  };
}

function toDate(value: Date | string | number): Date {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(result.getTime())) throw new PrivacyRequestError("INVALID_DATE", 400);
  return result;
}

function digestLocatorWithKey(value: string, key: Buffer): string {
  return createHmac("sha256", key)
    .update("openmapx/privacy/locator-digest/v1\0")
    .update(value)
    .digest("hex");
}

function digestLocator(value: string, ring: MasterKeyRing): string {
  return digestLocatorWithKey(value, ring.activeKey);
}

function encodeLocator(
  requestId: string,
  kind: string,
  locator: string,
  accountState: string,
  ring: MasterKeyRing,
  deploymentId: string,
  blobId = requestId,
): string {
  const aad = makeAad({ deploymentId, requestId, blobId, purpose: "request-locator" });
  return JSON.stringify(
    encryptEnvelope(
      Buffer.from(JSON.stringify({ kind, value: locator, accountState })),
      ring,
      "request-locator",
      aad,
    ),
  );
}

function boundedEventPayload(payload: Record<string, unknown> = {}): Record<string, unknown> {
  const parsed = eventPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PrivacyRequestError("INVALID_EVENT_PAYLOAD", 400);
  return parsed.data;
}

function notificationTemplateForState(
  state: RequestState,
): "clarification" | "ready" | "delivered" | "closed" | "refused" | null {
  switch (state) {
    case "clarification_needed":
      return "clarification";
    case "ready":
      return "ready";
    case "delivered":
      return "delivered";
    case "closed":
      return "closed";
    case "refused":
      return "refused";
    default:
      return null;
  }
}

function notificationValues(input: {
  requestId: string;
  recipientUserId: string | null;
  template:
    | "acknowledgement"
    | "clarification"
    | "extension"
    | "ready"
    | "delivered"
    | "closed"
    | "refused";
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

export class PrivacyRequestService {
  private readonly database: DbLike;
  private readonly catalogue: typeof SUBJECT_DATA_CATALOGUE;
  private readonly now: () => Date;
  private readonly getKeyRing: () => Promise<MasterKeyRing>;
  private readonly deploymentId: string;
  private readonly enqueue?: PrivacyRequestServiceOptions["enqueue"];
  private readonly deleteArtifactStorage?: PrivacyRequestServiceOptions["deleteArtifactStorage"];
  private readonly receiptPreservation?: ReceiptPreservationDependencies;

  constructor(options: PrivacyRequestServiceOptions = {}) {
    this.database = options.database ?? defaultDb;
    this.catalogue = options.catalogue ?? SUBJECT_DATA_CATALOGUE;
    this.now = options.now ?? (() => new Date());
    this.getKeyRing = () =>
      options.keyRingPromise ??
      (options.keyRing ? Promise.resolve(options.keyRing) : loadMasterKeyRingAsync());
    this.deploymentId = options.deploymentId ?? envString("OPENMAPX_DEPLOYMENT_ID", "openmapx");
    this.enqueue = options.enqueue;
    this.deleteArtifactStorage = options.deleteArtifactStorage;
    this.receiptPreservation = options.receiptPreservation;
  }

  async resolveVerifiedSubjectId(
    request: Pick<
      typeof dataSubjectRequest.$inferSelect,
      "id" | "userId" | "identityState" | "locatorType" | "encryptedLocator"
    >,
  ): Promise<string> {
    if (request.identityState !== "verified")
      throw new PrivacyRequestError("IDENTITY_REQUIRED", 409);
    if (request.userId) return request.userId;
    if (request.locatorType !== "user_id")
      throw new PrivacyRequestError("EXACT_SUBJECT_LOCATOR_REQUIRED", 409);
    try {
      const ring = await this.getKeyRing();
      const aad = makeAad({
        deploymentId: this.deploymentId,
        requestId: request.id,
        blobId: request.id,
        purpose: "request-locator",
      });
      const payload = JSON.parse(
        decryptEnvelope(
          JSON.parse(request.encryptedLocator) as CryptoEnvelope,
          ring,
          "request-locator",
          aad,
        ).toString("utf8"),
      ) as { kind?: unknown; value?: unknown };
      if (payload.kind !== "user_id" || typeof payload.value !== "string" || !payload.value)
        throw new Error("invalid locator");
      return payload.value;
    } catch {
      throw new PrivacyRequestError("EXACT_SUBJECT_LOCATOR_REQUIRED", 409);
    }
  }

  /** Exact historical case lookup across configured locator-key versions.
   * This exposes only keyed digests and never scans or returns raw locators. */
  async exactUserLocatorDigests(userId: string): Promise<readonly string[]> {
    if (!userId) throw new PrivacyRequestError("EXACT_SUBJECT_LOCATOR_REQUIRED", 409);
    const ring = await this.getKeyRing();
    return [
      ...new Set(
        [...ring.keys.values()].map((key) => digestLocatorWithKey(`user_id\0${userId}`, key)),
      ),
    ];
  }

  async create(input: CreateSubjectRequestInput): Promise<typeof dataSubjectRequest.$inferSelect> {
    const parsed = createSubjectRequestSchema.parse(input);
    const now = this.now();
    const requestedReceivedAt = parsed.receivedAt ? toDate(parsed.receivedAt) : now;
    const receivedAt = parsed.channel === "self_service" ? now : requestedReceivedAt;
    if (
      parsed.channel === "self_service" &&
      Math.abs(now.getTime() - requestedReceivedAt.getTime()) > 5 * 60_000
    ) {
      throw new PrivacyRequestError("RECEIPT_TIME_MUST_BE_CURRENT", 400);
    }
    const dueAt = calculateSubjectRequestDueAt(receivedAt, parsed.timeZone);
    const id = randomUUID();
    const subjectLocator = parsed.subject?.locator ?? parsed.userId;
    if (!subjectLocator) throw new PrivacyRequestError("SUBJECT_LOCATOR_REQUIRED", 400);
    const locatorType = parsed.subject?.locatorType ?? "user_id";
    const accountState = parsed.subject?.accountState ?? "current";
    const existing = parsed.userId
      ? await this.database
          .select()
          .from(dataSubjectRequest)
          .where(
            and(
              eq(dataSubjectRequest.userId, parsed.userId),
              eq(dataSubjectRequest.kind, parsed.kind),
              sql`${dataSubjectRequest.state} not in ('withdrawn', 'refused', 'closed', 'delivered', 'artifact_expired')`,
            ),
          )
          .orderBy(desc(dataSubjectRequest.createdAt))
          .limit(1)
      : [];
    if (existing[0]) return existing[0];
    const state: RequestState =
      parsed.channel === "self_service" ? "preserving" : "identity_pending";
    const ring = await this.getKeyRing();
    const locator = encodeLocator(
      id,
      locatorType,
      subjectLocator,
      accountState,
      ring,
      this.deploymentId,
    );
    const locatorDigest = digestLocator(`${locatorType}\0${subjectLocator}`, ring);
    const applicable = this.catalogue.filter(
      (registration) => registration.strategy !== "not_personal",
    );
    let racedRequest: typeof dataSubjectRequest.$inferSelect | undefined;
    const createdReceiptStorageKeys: string[] = [];
    try {
      await withPreservationRetentionLock(this.database, async (tx) => {
        await tx.insert(dataSubjectRequest).values({
          id,
          kind: parsed.kind,
          channel: parsed.channel,
          userId: parsed.userId,
          actorUserId: parsed.actorUserId ?? null,
          actorSessionId: parsed.actorSessionId ?? null,
          encryptedLocator: locator,
          locatorDigest,
          locatorType,
          accountState,
          locale: parsed.locale,
          timeZone: parsed.timeZone,
          state,
          version: 1,
          receivedAt,
          registeredAt: now,
          preservationAt: state === "preserving" ? now : null,
          // The preservation/collection cutoff is the controller's receipt-side
          // snapshot, not the caller's (possibly backdated) assisted receipt.
          // Collectors may replace this with their actual repeatable-read time.
          snapshotAt: now,
          dueAt,
          extension: null,
          identityState: state === "preserving" ? "verified" : "pending",
          deliveryState: "not_delivered",
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(dataSubjectRequestIdentity).values({
          id: randomUUID(),
          requestId: id,
          party: "subject",
          state: state === "preserving" ? "verified" : "pending",
          method: state === "preserving" ? "account_login" : null,
          authorityState: "not_applicable",
          deliveryAuthorized: 0,
          verifiedAt: state === "preserving" ? now : null,
          verifiedBy: state === "preserving" ? parsed.userId : null,
          createdAt: now,
          updatedAt: now,
        });
        if (parsed.representative) {
          const representativeBlobId = `${id}:representative`;
          await tx.insert(dataSubjectRequestIdentity).values({
            id: randomUUID(),
            requestId: id,
            party: "representative",
            contactEnvelope: encodeLocator(
              id,
              parsed.representative.contactType,
              parsed.representative.contact,
              "unknown",
              ring,
              this.deploymentId,
              representativeBlobId,
            ),
            contactDigest: digestLocator(
              `${parsed.representative.contactType}\0${parsed.representative.contact}`,
              ring,
            ),
            state: "pending",
            authorityState: "pending",
            deliveryAuthorized: 0,
            createdAt: now,
            updatedAt: now,
          });
        }
        await tx.insert(dataSubjectRequestEvent).values({
          id: randomUUID(),
          requestId: id,
          eventType: "received",
          ...actorPayload({
            kind: parsed.channel === "self_service" ? "subject" : "operator",
            id: parsed.actorUserId,
          }),
          payload: boundedEventPayload({ kind: parsed.kind, channel: parsed.channel }),
          payloadVersion: 1,
          ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
          createdAt: now,
        });
        if (parsed.userId) {
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
            .onConflictDoNothing({
              target: [
                dataSubjectRequestNotification.requestId,
                dataSubjectRequestNotification.template,
                dataSubjectRequestNotification.channel,
              ],
            });
        }
        for (const registration of applicable) {
          const required = 1;
          const unresolvedLocator = !parsed.userId && locatorType !== "user_id";
          await tx.insert(dataSubjectRequestTask).values({
            id: randomUUID(),
            requestId: id,
            taskKey: registration.id,
            registrationId: registration.id,
            collectorId: registration.collectorId ?? null,
            collectorVersion: registration.collectorVersion ?? null,
            source: registration.source,
            required,
            status: unresolvedLocator ? "operator_review" : "pending",
            attempts: 0,
            nextAttemptAt: now,
            cutoffAt: now,
            createdAt: now,
            updatedAt: now,
          });
          await tx.insert(dataSubjectRequestPreservation).values({
            id: randomUUID(),
            requestId: id,
            registrationId: registration.id,
            locatorDigest,
            sourceCutoffAt: now,
            startedAt: now,
            status: "held",
          });
          if (
            !unresolvedLocator &&
            registration.strategy === "operator_task" &&
            registration.id !== "redis-subject-controls"
          ) {
            const outcomeCode = `${registration.source}-preservation-action-required`;
            await tx
              .update(dataSubjectRequestTask)
              .set({
                status: "operator_review",
                publicCode: outcomeCode,
                exceptionCode: outcomeCode,
              })
              .where(
                and(
                  eq(dataSubjectRequestTask.requestId, id),
                  eq(dataSubjectRequestTask.registrationId, registration.id),
                ),
              );
            await tx
              .update(dataSubjectRequestPreservation)
              .set({ status: "action_required", outcomeCode })
              .where(
                and(
                  eq(dataSubjectRequestPreservation.requestId, id),
                  eq(dataSubjectRequestPreservation.registrationId, registration.id),
                ),
              );
          } else if (!unresolvedLocator && registration.source === "managed-service") {
            await tx
              .update(dataSubjectRequestPreservation)
              .set({
                status: "source_capture_pending",
                outcomeCode: "managed-source-capture-required",
              })
              .where(
                and(
                  eq(dataSubjectRequestPreservation.requestId, id),
                  eq(dataSubjectRequestPreservation.registrationId, registration.id),
                ),
              );
          }
        }
        if (parsed.userId && this.receiptPreservation) {
          await captureReceiptSourceSnapshots({
            database: tx as unknown as typeof defaultDb,
            requestId: id,
            userId: parsed.userId,
            cutoffAt: now,
            dueAt,
            timeZone: parsed.timeZone,
            dependencies: this.receiptPreservation,
            createdStorageKeys: createdReceiptStorageKeys,
          });
        }
      });
    } catch (error: unknown) {
      if (this.receiptPreservation?.store) {
        await Promise.allSettled(
          createdReceiptStorageKeys.map((storageKey) =>
            this.receiptPreservation?.store?.delete(storageKey),
          ),
        );
      }
      if (
        String(error).includes("data_subject_request_active_user_kind_idx") ||
        String(error).includes("duplicate key")
      ) {
        // The partial unique index is the race authority.  A concurrent
        // request may win between the initial read and our insert; return its
        // active case just like the non-racing path instead of exposing a
        // spurious conflict to the subject.  Do not enqueue the losing random
        // request ID.
        if (!parsed.userId) throw error;
        const raced = await this.database
          .select()
          .from(dataSubjectRequest)
          .where(
            and(
              eq(dataSubjectRequest.userId, parsed.userId),
              eq(dataSubjectRequest.kind, parsed.kind),
              sql`${dataSubjectRequest.state} not in ('withdrawn', 'refused', 'closed', 'delivered', 'artifact_expired')`,
            ),
          )
          .orderBy(desc(dataSubjectRequest.createdAt))
          .limit(1);
        if (raced[0]) racedRequest = raced[0];
        else throw new PrivacyRequestError("REQUEST_ALREADY_ACTIVE", 409);
      } else {
        throw error;
      }
    }
    if (racedRequest) return racedRequest;
    if (parsed.channel === "self_service") await this.enqueue?.(id);
    const rows = await this.database
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, id))
      .limit(1);
    if (!rows[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 500);
    return rows[0];
  }

  async listForUser(
    userId: string,
  ): Promise<ReadonlyArray<typeof dataSubjectRequest.$inferSelect>> {
    return this.database
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.userId, userId))
      .orderBy(desc(dataSubjectRequest.createdAt));
  }

  async getForUser(
    requestId: string,
    userId: string,
  ): Promise<typeof dataSubjectRequest.$inferSelect> {
    const rows = await this.database
      .select()
      .from(dataSubjectRequest)
      .where(and(eq(dataSubjectRequest.id, requestId), eq(dataSubjectRequest.userId, userId)))
      .limit(1);
    if (!rows[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
    return rows[0];
  }

  async transition(input: {
    requestId: string;
    from: RequestState;
    to: RequestState;
    version: number;
    actor: { kind: string; id?: string | null };
    reasonCode?: string;
    idempotencyKey?: string;
    capturedRegistrationIds?: readonly string[];
  }): Promise<typeof dataSubjectRequest.$inferSelect> {
    // Replay detection must precede transition validation.  A retry arriving
    // after the first caller reached a terminal state is still the same
    // idempotent mutation and must not be rejected as a new invalid edge.
    if (input.idempotencyKey) {
      const previous = await this.database
        .select()
        .from(dataSubjectRequestEvent)
        .where(
          and(
            eq(dataSubjectRequestEvent.requestId, input.requestId),
            eq(dataSubjectRequestEvent.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (previous[0]) {
        const current = await this.database
          .select()
          .from(dataSubjectRequest)
          .where(eq(dataSubjectRequest.id, input.requestId))
          .limit(1);
        if (current[0]) return current[0];
      }
    }
    assertValidRequestTransition(input.from, input.to);
    const now = this.now();
    let rows: Array<typeof dataSubjectRequest.$inferSelect>;
    try {
      rows = await this.database.transaction(async (tx) => {
        const updated = await tx
          .update(dataSubjectRequest)
          .set({
            state: input.to,
            version: sql`${dataSubjectRequest.version} + 1`,
            updatedAt: now,
            ...(input.to === "collecting"
              ? {
                  snapshotAt: sql`coalesce(${dataSubjectRequest.snapshotAt}, ${now.toISOString()})`,
                }
              : {}),
            ...(input.to === "withdrawn" ? { withdrawalAt: now } : {}),
            ...(input.to === "refused"
              ? { refusalCode: input.reasonCode ?? null, refusalReason: input.reasonCode ?? null }
              : {}),
            ...(input.to === "closed" ? { closedAt: now } : {}),
            ...(input.to === "delivered" ? { completedAt: now, deliveryState: "delivered" } : {}),
          })
          .where(
            and(
              eq(dataSubjectRequest.id, input.requestId),
              eq(dataSubjectRequest.state, input.from),
              eq(dataSubjectRequest.version, input.version),
            ),
          )
          .returning();
        if (!updated[0]) throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
        await tx.insert(dataSubjectRequestEvent).values({
          id: randomUUID(),
          requestId: input.requestId,
          eventType: `state_${input.to}`,
          ...actorPayload(input.actor),
          payload: boundedEventPayload(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
          payloadVersion: 1,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          createdAt: now,
        });
        const notificationTemplate = notificationTemplateForState(input.to);
        if (notificationTemplate && updated[0]?.userId) {
          await tx
            .insert(dataSubjectRequestNotification)
            .values(
              notificationValues({
                requestId: input.requestId,
                recipientUserId: updated[0].userId,
                template: notificationTemplate,
                locale: updated[0].locale,
                at: now,
              }),
            )
            .onConflictDoNothing({
              target: [
                dataSubjectRequestNotification.requestId,
                dataSubjectRequestNotification.template,
                dataSubjectRequestNotification.channel,
              ],
            });
        }
        if (input.to === "withdrawn" || input.to === "refused" || input.to === "closed") {
          await tx
            .update(dataSubjectRequestPreservation)
            .set({ releasedAt: now, status: "released" })
            .where(
              and(
                eq(dataSubjectRequestPreservation.requestId, input.requestId),
                sql`${dataSubjectRequestPreservation.releasedAt} is null`,
              ),
            );
        }
        if (input.to === "ready" && input.capturedRegistrationIds?.length) {
          await tx
            .update(dataSubjectRequestPreservation)
            .set({ capturedAt: now, status: "captured", outcomeCode: "artifact-source-captured" })
            .where(
              and(
                eq(dataSubjectRequestPreservation.requestId, input.requestId),
                inArray(dataSubjectRequestPreservation.registrationId, [
                  ...new Set(input.capturedRegistrationIds),
                ]),
                sql`${dataSubjectRequestPreservation.releasedAt} is null`,
              ),
            );
        }
        return updated;
      });
    } catch (error) {
      if (
        input.idempotencyKey &&
        String(error).includes("data_subject_request_event_idempotency_idx")
      ) {
        const current = await this.database
          .select()
          .from(dataSubjectRequest)
          .where(eq(dataSubjectRequest.id, input.requestId))
          .limit(1);
        if (current[0]) return current[0];
      }
      throw error;
    }
    if (!rows[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
    return rows[0];
  }

  async withdraw(
    requestId: string,
    userId: string,
    version: number,
    idempotencyKey?: string,
  ): Promise<typeof dataSubjectRequest.$inferSelect> {
    const current = await this.getForUser(requestId, userId);
    const result = await this.transition({
      requestId,
      from: current.state,
      to: "withdrawn",
      version,
      actor: { kind: "subject", id: userId },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    // Withdrawal invalidates every unpublished artifact immediately.  The
    // retention job remains a repair path for a crash between the database
    // state change and physical ciphertext deletion.
    const artifacts = await this.database
      .select({ id: dataExportArtifact.id, storageKey: dataExportArtifact.storageKey })
      .from(dataExportArtifact)
      .where(
        and(
          eq(dataExportArtifact.requestId, requestId),
          sql`${dataExportArtifact.state} not in ('deleted', 'revoked')`,
        ),
      );
    if (artifacts.length) {
      await this.database
        .update(dataExportArtifact)
        .set({ state: "revoked", revokedAt: this.now() })
        .where(
          and(
            eq(dataExportArtifact.requestId, requestId),
            sql`${dataExportArtifact.state} not in ('deleted', 'revoked')`,
          ),
        );
      if (this.deleteArtifactStorage) {
        for (const artifact of artifacts) {
          try {
            await this.deleteArtifactStorage(artifact.storageKey);
          } catch {
            /* cleanup retries later */
          }
        }
      }
    }
    return result;
  }

  async recordExtension(input: {
    requestId: string;
    version: number;
    extendedUntil: Date;
    extensionNotifiedAt: Date;
    reasonCode: string;
    actorId: string;
    idempotencyKey?: string;
  }): Promise<typeof dataSubjectRequest.$inferSelect> {
    if (!input.reasonCode || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.reasonCode))
      throw new PrivacyRequestError("INVALID_EXTENSION_REASON", 400);
    const currentRows = await this.database
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, input.requestId))
      .limit(1);
    const current = currentRows[0];
    if (!current) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
    const extendedUntil = toDate(input.extendedUntil);
    const notifiedAt = toDate(input.extensionNotifiedAt);
    const max = addCalendarMonths(current.dueAt, 2, current.timeZone);
    if (extendedUntil < current.dueAt || extendedUntil > max || notifiedAt > current.dueAt)
      throw new PrivacyRequestError("INVALID_EXTENSION", 400);
    const now = this.now();
    if (input.idempotencyKey) {
      const previous = await this.database
        .select()
        .from(dataSubjectRequestEvent)
        .where(
          and(
            eq(dataSubjectRequestEvent.requestId, input.requestId),
            eq(dataSubjectRequestEvent.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (previous[0]) return current;
    }
    const rows = await this.database.transaction(async (tx) => {
      const updated = await tx
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
        .where(
          and(
            eq(dataSubjectRequest.id, input.requestId),
            eq(dataSubjectRequest.version, input.version),
          ),
        )
        .returning();
      if (!updated[0]) throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
      await tx.insert(dataSubjectRequestEvent).values({
        id: randomUUID(),
        requestId: input.requestId,
        eventType: "extended",
        ...actorPayload({ kind: "privacy_admin", id: input.actorId }),
        payload: boundedEventPayload({ reasonCode: input.reasonCode }),
        payloadVersion: 1,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        createdAt: now,
      });
      if (updated[0]?.userId) {
        await tx
          .insert(dataSubjectRequestNotification)
          .values(
            notificationValues({
              requestId: input.requestId,
              recipientUserId: updated[0].userId,
              template: "extension",
              locale: updated[0].locale,
              at: now,
            }),
          )
          .onConflictDoNothing({
            target: [
              dataSubjectRequestNotification.requestId,
              dataSubjectRequestNotification.template,
              dataSubjectRequestNotification.channel,
            ],
          });
      }
      return updated;
    });
    return rows[0];
  }

  async markTask(input: {
    taskId: string;
    requestId: string;
    status: TaskState;
    actorId?: string;
    reasonCode?: string;
    redactionCode?: string;
    recordCount?: number;
    requestVersion?: number;
    idempotencyKey?: string;
  }): Promise<void> {
    if (
      ["not_applicable", "operator_review", "canceled"].includes(input.status) &&
      !input.reasonCode
    )
      throw new PrivacyRequestError("TASK_REASON_REQUIRED", 400);
    const now = this.now();
    const operationDigest = idempotencyFingerprint({
      taskId: input.taskId,
      status: input.status,
      reasonCode: input.reasonCode ?? null,
      redactionCode: input.redactionCode ?? null,
      recordCount: input.recordCount ?? null,
    });
    if (input.idempotencyKey) {
      const previous = await this.database
        .select({
          eventType: dataSubjectRequestEvent.eventType,
          payload: dataSubjectRequestEvent.payload,
        })
        .from(dataSubjectRequestEvent)
        .where(
          and(
            eq(dataSubjectRequestEvent.requestId, input.requestId),
            eq(dataSubjectRequestEvent.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (previous[0]) {
        const previousDigest =
          previous[0].payload && typeof previous[0].payload === "object"
            ? (previous[0].payload as Record<string, unknown>).operationDigest
            : undefined;
        if (previous[0].eventType !== `task_${input.status}` || previousDigest !== operationDigest)
          throw new PrivacyRequestError("IDEMPOTENCY_KEY_REUSED", 409);
        return;
      }
    }
    let updated: Array<{ id: string }>;
    try {
      updated = await this.database.transaction(async (tx) => {
        // Human task decisions are request mutations as well as task
        // mutations.  Keep the optimistic request version in the same
        // transaction so a stale caseworker screen cannot overwrite a newer
        // decision.  System collectors may omit this field because their
        // durable task claim is the concurrency boundary.
        if (input.requestVersion !== undefined) {
          const requestChanged = await tx
            .update(dataSubjectRequest)
            .set({ version: sql`${dataSubjectRequest.version} + 1`, updatedAt: now })
            .where(
              and(
                eq(dataSubjectRequest.id, input.requestId),
                eq(dataSubjectRequest.version, input.requestVersion),
                sql`${dataSubjectRequest.state} in ('preserving', 'collecting', 'pending_processor', 'operator_review', 'clarification_needed')`,
              ),
            )
            .returning({ id: dataSubjectRequest.id });
          if (!requestChanged[0]) {
            const [current] = await tx
              .select({ version: dataSubjectRequest.version, state: dataSubjectRequest.state })
              .from(dataSubjectRequest)
              .where(eq(dataSubjectRequest.id, input.requestId))
              .limit(1);
            if (current?.version === input.requestVersion)
              throw new PrivacyRequestError("TASK_DECISION_NOT_ALLOWED", 409);
            throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
          }
        }
        const changed = await tx
          .update(dataSubjectRequestTask)
          .set({
            status: input.status,
            exceptionCode: input.reasonCode ?? null,
            redactionCode: input.redactionCode ?? null,
            recordCount: input.recordCount ?? null,
            collectedAt: ["complete", "not_applicable"].includes(input.status) ? now : null,
            updatedAt: now,
          })
          .where(
            and(
              eq(dataSubjectRequestTask.id, input.taskId),
              eq(dataSubjectRequestTask.requestId, input.requestId),
            ),
          )
          .returning({ id: dataSubjectRequestTask.id });
        if (!changed[0]) throw new PrivacyRequestError("TASK_NOT_FOUND", 404);
        if (input.idempotencyKey)
          await tx.insert(dataSubjectRequestEvent).values({
            id: randomUUID(),
            requestId: input.requestId,
            eventType: `task_${input.status}`,
            ...actorPayload({
              kind: input.actorId ? "privacy_admin" : "system",
              id: input.actorId,
            }),
            payload: boundedEventPayload({
              taskId: input.taskId,
              ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
              ...(input.redactionCode ? { redactionCode: input.redactionCode } : {}),
              operationDigest,
            }),
            payloadVersion: 1,
            idempotencyKey: input.idempotencyKey,
            createdAt: now,
          });
        return changed;
      });
    } catch (error) {
      if (input.idempotencyKey && String(error).toLowerCase().includes("idempotency")) {
        const previous = await this.database
          .select({
            eventType: dataSubjectRequestEvent.eventType,
            payload: dataSubjectRequestEvent.payload,
          })
          .from(dataSubjectRequestEvent)
          .where(
            and(
              eq(dataSubjectRequestEvent.requestId, input.requestId),
              eq(dataSubjectRequestEvent.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        const previousDigest =
          previous[0]?.payload && typeof previous[0].payload === "object"
            ? (previous[0].payload as Record<string, unknown>).operationDigest
            : undefined;
        if (previous[0]?.eventType === `task_${input.status}` && previousDigest === operationDigest)
          return;
        throw new PrivacyRequestError("IDEMPOTENCY_KEY_REUSED", 409);
      }
      throw error;
    }
    if (!updated[0]) throw new PrivacyRequestError("TASK_NOT_FOUND", 404);
  }

  /** Assign a human/operator task with the same request-level CAS used by all
   * other caseworker mutations.  Assignment is intentionally separate from a
   * task decision so taking ownership never implies that the source result is
   * complete or reviewed.
   */
  async assignTask(input: {
    requestId: string;
    taskId: string;
    version: number;
    assignedTo: string | null;
    actorId: string;
    idempotencyKey: string;
  }): Promise<typeof dataSubjectRequest.$inferSelect> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/.test(input.idempotencyKey))
      throw new PrivacyRequestError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const previous = await this.database
      .select({ id: dataSubjectRequestEvent.id })
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, input.requestId),
          eq(dataSubjectRequestEvent.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (previous[0]) {
      const current = await this.database
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, input.requestId))
        .limit(1);
      if (current[0]) return current[0];
    }
    const now = this.now();
    try {
      const rows = await this.database.transaction(async (tx) => {
        const task = await tx
          .select({ id: dataSubjectRequestTask.id })
          .from(dataSubjectRequestTask)
          .where(
            and(
              eq(dataSubjectRequestTask.id, input.taskId),
              eq(dataSubjectRequestTask.requestId, input.requestId),
            ),
          )
          .limit(1);
        if (!task[0]) throw new PrivacyRequestError("TASK_NOT_FOUND", 404);
        const updated = await tx
          .update(dataSubjectRequest)
          .set({ version: sql`${dataSubjectRequest.version} + 1`, updatedAt: now })
          .where(
            and(
              eq(dataSubjectRequest.id, input.requestId),
              eq(dataSubjectRequest.version, input.version),
            ),
          )
          .returning();
        if (!updated[0]) throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
        await tx
          .update(dataSubjectRequestTask)
          .set({ assignedTo: input.assignedTo, updatedAt: now })
          .where(
            and(
              eq(dataSubjectRequestTask.id, input.taskId),
              eq(dataSubjectRequestTask.requestId, input.requestId),
            ),
          );
        await tx.insert(dataSubjectRequestEvent).values({
          id: randomUUID(),
          requestId: input.requestId,
          eventType: "task_assigned",
          ...actorPayload({ kind: "privacy_admin", id: input.actorId }),
          payload: boundedEventPayload({
            taskId: input.taskId,
            assigned: input.assignedTo !== null,
          }),
          payloadVersion: 1,
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
        });
        return updated;
      });
      if (!rows[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
      return rows[0];
    } catch (error) {
      if (String(error).toLowerCase().includes("idempotency")) {
        const current = await this.database
          .select()
          .from(dataSubjectRequest)
          .where(eq(dataSubjectRequest.id, input.requestId))
          .limit(1);
        if (current[0]) return current[0];
      }
      throw error;
    }
  }

  /** Prove an assisted subject through a real, newly created authenticated
   * account session. The protected locator is compared inside the service;
   * no caseworker-supplied identity assertion is accepted. */
  async recordAccountLoginProof(input: {
    requestId: string;
    userId: string;
    sessionId: string;
    idempotencyKey: string;
  }): Promise<typeof dataSubjectRequest.$inferSelect> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/.test(input.idempotencyKey))
      throw new PrivacyRequestError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const operationDigest = idempotencyFingerprint({
      requestId: input.requestId,
      userId: input.userId,
      method: "account_login",
    });
    const now = this.now();
    let shouldEnqueue = false;
    const result = await this.database.transaction(async (tx) => {
      const [duplicate] = await tx
        .select({
          eventType: dataSubjectRequestEvent.eventType,
          payload: dataSubjectRequestEvent.payload,
        })
        .from(dataSubjectRequestEvent)
        .where(
          and(
            eq(dataSubjectRequestEvent.requestId, input.requestId),
            eq(dataSubjectRequestEvent.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (duplicate) {
        const previousDigest =
          duplicate.payload && typeof duplicate.payload === "object"
            ? (duplicate.payload as Record<string, unknown>).operationDigest
            : undefined;
        if (
          duplicate.eventType !== "account_login_identity_proved" ||
          previousDigest !== operationDigest
        )
          throw new PrivacyRequestError("IDEMPOTENCY_KEY_REUSED", 409);
        const [current] = await tx
          .select()
          .from(dataSubjectRequest)
          .where(eq(dataSubjectRequest.id, input.requestId))
          .limit(1);
        if (!current) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
        return current;
      }
      const [request] = await tx
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, input.requestId))
        .for("update")
        .limit(1);
      if (
        !request ||
        request.channel === "self_service" ||
        request.accountState === "deleted" ||
        !["identity_pending", "clarification_needed"].includes(request.state)
      )
        throw new PrivacyRequestError("ACCOUNT_LOGIN_PROOF_FAILED", 404);
      const [[assurance], [account], identities] = await Promise.all([
        tx
          .select({
            userId: sessionAuthAssurance.userId,
            authenticatedAt: sessionAuthAssurance.authenticatedAt,
          })
          .from(sessionAuthAssurance)
          .where(eq(sessionAuthAssurance.sessionId, input.sessionId))
          .limit(1),
        tx.select({ email: user.email }).from(user).where(eq(user.id, input.userId)).limit(1),
        tx
          .select()
          .from(dataSubjectRequestIdentity)
          .where(eq(dataSubjectRequestIdentity.requestId, input.requestId)),
      ]);
      if (
        !assurance ||
        assurance.userId !== input.userId ||
        assurance.authenticatedAt <= request.registeredAt ||
        !account
      )
        throw new PrivacyRequestError("ACCOUNT_LOGIN_PROOF_FAILED", 404);
      let locator: { kind?: unknown; value?: unknown };
      try {
        const ring = await this.getKeyRing();
        locator = JSON.parse(
          decryptEnvelope(
            JSON.parse(request.encryptedLocator) as CryptoEnvelope,
            ring,
            "request-locator",
            makeAad({
              deploymentId: this.deploymentId,
              requestId: request.id,
              blobId: request.id,
              purpose: "request-locator",
            }),
          ).toString("utf8"),
        ) as { kind?: unknown; value?: unknown };
      } catch {
        throw new PrivacyRequestError("ACCOUNT_LOGIN_PROOF_FAILED", 404);
      }
      const matches =
        request.userId === input.userId ||
        (request.userId === null &&
          ((locator.kind === "user_id" && locator.value === input.userId) ||
            (locator.kind === "email" &&
              typeof locator.value === "string" &&
              locator.value.trim().toLowerCase() === account.email.trim().toLowerCase())));
      const subject = identities.find((identity) => identity.party === "subject");
      if (!matches || !subject || subject.state === "verified")
        throw new PrivacyRequestError("ACCOUNT_LOGIN_PROOF_FAILED", 404);
      await tx
        .update(dataSubjectRequestIdentity)
        .set({
          state: "verified",
          method: "account_login",
          verifiedAt: now,
          verifiedBy: input.userId,
          updatedAt: now,
        })
        .where(eq(dataSubjectRequestIdentity.id, subject.id));
      const representative = identities.find((identity) => identity.party === "representative");
      const identityComplete =
        !representative ||
        (representative.state === "verified" && representative.authorityState === "approved");
      const [updated] = await tx
        .update(dataSubjectRequest)
        .set({
          userId: input.userId,
          identityState: "verified",
          state: identityComplete ? "preserving" : "identity_pending",
          version: sql`${dataSubjectRequest.version} + 1`,
          ...(identityComplete
            ? {
                preservationAt: sql`coalesce(${dataSubjectRequest.preservationAt}, ${now.toISOString()})`,
                snapshotAt: sql`coalesce(${dataSubjectRequest.snapshotAt}, ${now.toISOString()})`,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(dataSubjectRequest.id, request.id))
        .returning();
      if (!updated) throw new PrivacyRequestError("ACCOUNT_LOGIN_PROOF_FAILED", 409);
      await tx.insert(dataSubjectRequestEvent).values({
        id: randomUUID(),
        requestId: request.id,
        eventType: "account_login_identity_proved",
        actorKind: "subject",
        actorId: input.userId,
        payloadVersion: 1,
        payload: boundedEventPayload({ method: "account_login", operationDigest }),
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
      });
      shouldEnqueue = identityComplete;
      return updated;
    });
    if (shouldEnqueue) await this.enqueue?.(input.requestId);
    return result;
  }

  async recordIdentityReview(input: {
    requestId: string;
    version: number;
    party: "subject" | "representative";
    outcome: "verified" | "failed" | "clarification";
    method?: "account_login" | "verified_email_challenge" | "exceptional_evidence";
    reasonableDoubtCode?: string;
    evidenceAttachmentId?: string;
    authorityOutcome?: "pending" | "approved" | "rejected";
    authorityAttachmentId?: string;
    deliveryAuthorized?: boolean;
    actorId: string;
    idempotencyKey: string;
  }): Promise<typeof dataSubjectRequest.$inferSelect> {
    const parsed = identityReviewSchema.safeParse({
      version: input.version,
      party: input.party,
      outcome: input.outcome,
      method: input.method,
      reasonableDoubtCode: input.reasonableDoubtCode,
      evidenceAttachmentId: input.evidenceAttachmentId,
      authorityOutcome: input.authorityOutcome,
      authorityAttachmentId: input.authorityAttachmentId,
      deliveryAuthorized: input.deliveryAuthorized,
    });
    if (!parsed.success) throw new PrivacyRequestError("INVALID_IDENTITY_REVIEW", 400);
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/.test(input.idempotencyKey))
      throw new PrivacyRequestError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const now = this.now();
    const eventType =
      input.party === "subject" ? "subject_identity_reviewed" : "representative_reviewed";
    const operationDigest = idempotencyFingerprint({
      party: input.party,
      outcome: input.outcome,
      method: input.method ?? null,
      reasonableDoubtCode: input.reasonableDoubtCode ?? null,
      evidenceAttachmentId: input.evidenceAttachmentId ?? null,
      authorityOutcome: input.authorityOutcome ?? null,
      authorityAttachmentId: input.authorityAttachmentId ?? null,
      deliveryAuthorized: input.deliveryAuthorized ?? null,
    });
    let shouldEnqueue = false;
    const row = await this.database.transaction(async (tx) => {
      const duplicate = await tx
        .select({
          eventType: dataSubjectRequestEvent.eventType,
          payload: dataSubjectRequestEvent.payload,
        })
        .from(dataSubjectRequestEvent)
        .where(
          and(
            eq(dataSubjectRequestEvent.requestId, input.requestId),
            eq(dataSubjectRequestEvent.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (duplicate[0]) {
        const previousDigest =
          duplicate[0].payload && typeof duplicate[0].payload === "object"
            ? (duplicate[0].payload as Record<string, unknown>).operationDigest
            : undefined;
        if (duplicate[0].eventType !== eventType || previousDigest !== operationDigest)
          throw new PrivacyRequestError("IDEMPOTENCY_KEY_REUSED", 409);
        const current = await tx
          .select()
          .from(dataSubjectRequest)
          .where(eq(dataSubjectRequest.id, input.requestId))
          .limit(1);
        if (!current[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
        return current[0];
      }
      const currentRows = await tx
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, input.requestId))
        .limit(1);
      const current = currentRows[0];
      if (!current) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
      if (current.version !== input.version)
        throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
      if (input.method === "verified_email_challenge")
        throw new PrivacyRequestError("EMAIL_CHALLENGE_PROOF_REQUIRED", 409);
      if (input.method === "account_login")
        throw new PrivacyRequestError("ACCOUNT_LOGIN_PROOF_REQUIRED", 409);
      if (!["identity_pending", "clarification_needed", "preserving"].includes(current.state))
        throw new PrivacyRequestError("IDENTITY_OUTCOME_NOT_ALLOWED", 409);
      const identityRows = await tx
        .select()
        .from(dataSubjectRequestIdentity)
        .where(
          and(
            eq(dataSubjectRequestIdentity.requestId, input.requestId),
            eq(dataSubjectRequestIdentity.party, input.party),
          ),
        )
        .limit(1);
      if (!identityRows[0]) throw new PrivacyRequestError("IDENTITY_PARTY_NOT_FOUND", 404);
      const existingIdentity = identityRows[0];
      if (input.outcome === "verified" && !input.method && existingIdentity.state !== "verified")
        throw new PrivacyRequestError("IDENTITY_PROOF_REQUIRED", 409);
      for (const attachmentId of [input.evidenceAttachmentId, input.authorityAttachmentId]) {
        if (!attachmentId) continue;
        const attachment = await tx
          .select({
            id: dataSubjectRequestAttachment.id,
            purpose: dataSubjectRequestAttachment.purpose,
          })
          .from(dataSubjectRequestAttachment)
          .where(
            and(
              eq(dataSubjectRequestAttachment.id, attachmentId),
              eq(dataSubjectRequestAttachment.requestId, input.requestId),
              sql`${dataSubjectRequestAttachment.deletedAt} is null`,
            ),
          )
          .limit(1);
        if (!attachment[0]) throw new PrivacyRequestError("IDENTITY_ATTACHMENT_NOT_FOUND", 400);
        if (
          attachmentId === input.authorityAttachmentId &&
          attachment[0].purpose !== "representative_authority"
        )
          throw new PrivacyRequestError("INVALID_AUTHORITY_ATTACHMENT", 400);
        if (
          attachmentId === input.evidenceAttachmentId &&
          attachment[0].purpose !== "identity_evidence"
        )
          throw new PrivacyRequestError("INVALID_IDENTITY_ATTACHMENT", 400);
      }
      await tx
        .update(dataSubjectRequestIdentity)
        .set({
          state: input.outcome,
          method: input.method ?? existingIdentity.method,
          reasonableDoubtCode: input.reasonableDoubtCode ?? existingIdentity.reasonableDoubtCode,
          evidenceAttachmentId: input.evidenceAttachmentId ?? existingIdentity.evidenceAttachmentId,
          ...(input.party === "representative"
            ? {
                authorityState: input.authorityOutcome ?? existingIdentity.authorityState,
                authorityAttachmentId:
                  input.authorityAttachmentId ?? existingIdentity.authorityAttachmentId,
                deliveryAuthorized:
                  input.outcome !== "verified" || input.authorityOutcome === "rejected"
                    ? 0
                    : input.deliveryAuthorized === undefined
                      ? existingIdentity.deliveryAuthorized
                      : input.deliveryAuthorized
                        ? 1
                        : 0,
              }
            : {}),
          verifiedAt: input.outcome === "verified" ? (existingIdentity.verifiedAt ?? now) : null,
          verifiedBy:
            input.outcome === "verified" ? (existingIdentity.verifiedBy ?? input.actorId) : null,
          updatedAt: now,
        })
        .where(eq(dataSubjectRequestIdentity.id, existingIdentity.id));
      const allIdentities = await tx
        .select()
        .from(dataSubjectRequestIdentity)
        .where(eq(dataSubjectRequestIdentity.requestId, input.requestId));
      const subject = allIdentities.find((identity) => identity.party === "subject");
      const representative = allIdentities.find((identity) => identity.party === "representative");
      const identityComplete =
        subject?.state === "verified" &&
        (!representative ||
          (representative.state === "verified" && representative.authorityState === "approved"));
      const clarificationRequired =
        input.outcome === "clarification" ||
        (representative !== undefined && representative.authorityState === "rejected");
      const nextState = identityComplete
        ? "preserving"
        : clarificationRequired
          ? "clarification_needed"
          : "identity_pending";
      const updated = await tx
        .update(dataSubjectRequest)
        .set({
          identityState: subject?.state ?? current.identityState,
          state: nextState,
          version: sql`${dataSubjectRequest.version} + 1`,
          updatedAt: now,
          ...(nextState === "preserving"
            ? {
                preservationAt: sql`coalesce(${dataSubjectRequest.preservationAt}, ${now.toISOString()})`,
                snapshotAt: sql`coalesce(${dataSubjectRequest.snapshotAt}, ${now.toISOString()})`,
              }
            : {}),
        })
        .where(
          and(
            eq(dataSubjectRequest.id, input.requestId),
            eq(dataSubjectRequest.version, input.version),
          ),
        )
        .returning();
      if (!updated[0]) throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
      await tx.insert(dataSubjectRequestEvent).values({
        id: randomUUID(),
        requestId: input.requestId,
        eventType,
        actorKind: "privacy_admin",
        actorId: input.actorId,
        payloadVersion: 1,
        payload: boundedEventPayload({
          party: input.party,
          outcome: input.outcome,
          method: input.method ?? null,
          authorityOutcome: input.authorityOutcome ?? null,
          deliveryAuthorized: input.deliveryAuthorized ?? null,
          operationDigest,
        }),
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
      });
      shouldEnqueue = current.state !== "preserving" && nextState === "preserving";
      return updated[0];
    });
    if (shouldEnqueue) await this.enqueue?.(input.requestId);
    return row;
  }

  async recordDecision(input: {
    requestId: string;
    version: number;
    decision: "refused" | "clarification_needed" | "operator_review";
    reasonCode: string;
    actorId: string;
    idempotencyKey: string;
  }): Promise<typeof dataSubjectRequest.$inferSelect> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/.test(input.idempotencyKey))
      throw new PrivacyRequestError("IDEMPOTENCY_KEY_REQUIRED", 400);
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.reasonCode))
      throw new PrivacyRequestError("INVALID_REASON", 400);
    const current = await this.database
      .select()
      .from(dataSubjectRequest)
      .where(eq(dataSubjectRequest.id, input.requestId))
      .limit(1);
    if (!current[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
    const previous = await this.database
      .select({ id: dataSubjectRequestEvent.id })
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, input.requestId),
          eq(dataSubjectRequestEvent.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (previous[0]) return current[0];
    if (input.decision === "refused") {
      return this.transition({
        requestId: input.requestId,
        from: current[0].state,
        to: "refused",
        version: input.version,
        actor: { kind: "privacy_admin", id: input.actorId },
        reasonCode: input.reasonCode,
        idempotencyKey: input.idempotencyKey,
      });
    }
    const target =
      input.decision === "operator_review" ? "operator_review" : "clarification_needed";
    if (current[0].state === target) {
      try {
        const rows = await this.database.transaction(async (tx) => {
          await tx.insert(dataSubjectRequestEvent).values({
            id: randomUUID(),
            requestId: input.requestId,
            eventType: `decision_${input.decision}`,
            ...actorPayload({ kind: "privacy_admin", id: input.actorId }),
            payload: boundedEventPayload({ reasonCode: input.reasonCode }),
            payloadVersion: 1,
            idempotencyKey: input.idempotencyKey,
            createdAt: this.now(),
          });
          return tx
            .select()
            .from(dataSubjectRequest)
            .where(eq(dataSubjectRequest.id, input.requestId))
            .limit(1);
        });
        if (!rows[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
        return rows[0];
      } catch (error) {
        if (String(error).toLowerCase().includes("idempotency")) {
          const latest = await this.database
            .select()
            .from(dataSubjectRequest)
            .where(eq(dataSubjectRequest.id, input.requestId))
            .limit(1);
          if (latest[0]) return latest[0];
        }
        throw error;
      }
    }
    return this.transition({
      requestId: input.requestId,
      from: current[0].state,
      to: target,
      version: input.version,
      actor: { kind: "privacy_admin", id: input.actorId },
      reasonCode: input.reasonCode,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async assertReadyForAssembly(requestId: string, completedClaim?: string): Promise<void> {
    const tasks = await this.database
      .select({
        id: dataSubjectRequestTask.id,
        status: dataSubjectRequestTask.status,
        required: dataSubjectRequestTask.required,
      })
      .from(dataSubjectRequestTask)
      .where(eq(dataSubjectRequestTask.requestId, requestId));
    try {
      assertAssemblyReady(
        tasks.map((task) => ({
          status: task.id === completedClaim ? "complete" : task.status,
          required: task.required === 1,
        })),
      );
    } catch {
      throw new PrivacyRequestError("REQUEST_NOT_READY", 409);
    }
  }

  /** Recover a request left in `assembling` after a process crash or a failed
   * writer.  The transition is deliberately explicit and auditable: it is a
   * technical retry, never a legal refusal/closure.  Any assembly metadata is
   * revoked in the same transaction and its ciphertext is handed to the
   * physical cleanup callback afterwards. */
  async recoverInterruptedAssembly(input: {
    requestId: string;
    version: number;
  }): Promise<boolean> {
    const now = this.now();
    const recovered = await this.database.transaction(async (tx) => {
      const updated = await tx
        .update(dataSubjectRequest)
        .set({
          state: "collecting",
          version: sql`${dataSubjectRequest.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(dataSubjectRequest.id, input.requestId),
            eq(dataSubjectRequest.state, "assembling"),
            eq(dataSubjectRequest.version, input.version),
          ),
        )
        .returning({ id: dataSubjectRequest.id });
      if (!updated[0]) return null;
      const artifacts = await tx
        .update(dataExportArtifact)
        .set({ state: "revoked", revokedAt: now })
        .where(
          and(
            eq(dataExportArtifact.requestId, input.requestId),
            sql`${dataExportArtifact.state} in ('assembling', 'ready')`,
          ),
        )
        .returning({ storageKey: dataExportArtifact.storageKey });
      await tx
        .update(dataSubjectRequestTask)
        .set({
          status: "pending",
          nextAttemptAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(dataSubjectRequestTask.requestId, input.requestId),
            eq(dataSubjectRequestTask.status, "complete"),
            sql`${dataSubjectRequestTask.collectorId} is not null`,
          ),
        );
      await tx.insert(dataSubjectRequestEvent).values({
        id: randomUUID(),
        requestId: input.requestId,
        eventType: "assembly_recovered",
        actorKind: "system",
        actorId: "privacy-recovery",
        payloadVersion: 1,
        payload: boundedEventPayload({ reasonCode: "assembly-interrupted" }),
        createdAt: now,
      });
      return artifacts;
    });
    if (!recovered) return false;
    for (const artifact of recovered) {
      try {
        await this.deleteArtifactStorage?.(artifact.storageKey);
      } catch {
        /* cleanup retries later */
      }
    }
    return true;
  }

  /** Startup recovery for assemblies that have been untouched longer than the
   * writer watchdog window.  The compare-and-set in
   * `recoverInterruptedAssembly` makes this safe when multiple API instances
   * restart together. */
  async recoverStaleAssemblies(staleAfterMs = 15 * 60_000): Promise<number> {
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1_000)
      throw new PrivacyRequestError("INVALID_RECOVERY_WINDOW", 500);
    const cutoff = new Date(this.now().getTime() - staleAfterMs);
    const candidates = await this.database
      .select({ id: dataSubjectRequest.id, version: dataSubjectRequest.version })
      .from(dataSubjectRequest)
      .where(
        and(
          eq(dataSubjectRequest.state, "assembling"),
          sql`${dataSubjectRequest.updatedAt} < ${cutoff.toISOString()}`,
        ),
      );
    let recovered = 0;
    for (const candidate of candidates) {
      if (
        await this.recoverInterruptedAssembly({
          requestId: candidate.id,
          version: candidate.version,
        })
      )
        recovered += 1;
    }
    return recovered;
  }

  async revokeArtifact(
    requestId: string,
    artifactId: string,
    userId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (idempotencyKey && !/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/.test(idempotencyKey))
      throw new PrivacyRequestError("IDEMPOTENCY_KEY_REQUIRED", 400);
    if (idempotencyKey) {
      const previous = await this.database
        .select({ id: dataSubjectRequestEvent.id })
        .from(dataSubjectRequestEvent)
        .where(
          and(
            eq(dataSubjectRequestEvent.requestId, requestId),
            eq(dataSubjectRequestEvent.idempotencyKey, idempotencyKey),
            eq(dataSubjectRequestEvent.eventType, "artifact_revoked"),
          ),
        )
        .limit(1);
      if (previous[0]) return;
    }
    const now = this.now();
    // Ownership is part of the mutation predicate.  Never revoke an artifact
    // first and discover afterwards that its request belonged to somebody
    // else: that would be a cross-account destructive side effect.
    const rows = await this.database
      .select({ artifactId: dataExportArtifact.id, storageKey: dataExportArtifact.storageKey })
      .from(dataExportArtifact)
      .innerJoin(dataSubjectRequest, eq(dataExportArtifact.requestId, dataSubjectRequest.id))
      .where(
        and(
          eq(dataExportArtifact.id, artifactId),
          eq(dataExportArtifact.requestId, requestId),
          eq(dataSubjectRequest.userId, userId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new PrivacyRequestError("ARTIFACT_NOT_FOUND", 404);
    await this.database.transaction(async (tx) => {
      const updated = await tx
        .update(dataExportArtifact)
        .set({ state: "revoked", revokedAt: now })
        .where(
          and(
            eq(dataExportArtifact.id, artifactId),
            eq(dataExportArtifact.requestId, requestId),
            eq(dataExportArtifact.state, "ready"),
          ),
        )
        .returning({ id: dataExportArtifact.id });
      if (!updated[0]) throw new PrivacyRequestError("ARTIFACT_NOT_FOUND", 404);
      await tx
        .update(dataSubjectRequest)
        .set({ deliveryState: "revoked", updatedAt: now })
        .where(and(eq(dataSubjectRequest.id, requestId), eq(dataSubjectRequest.userId, userId)));
      await tx.insert(dataSubjectRequestEvent).values({
        id: randomUUID(),
        requestId,
        eventType: "artifact_revoked",
        actorKind: "subject",
        actorId: userId,
        payloadVersion: 1,
        payload: boundedEventPayload({}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        createdAt: now,
      });
    });
    await this.deleteArtifactStorage?.(rows[0].storageKey);
  }

  /** Start a fresh generation while retaining the immutable case history. The
   * previous ciphertext is revoked before a new collector run can be queued. */
  async regenerate(
    requestId: string,
    userId: string,
    version: number,
    idempotencyKey: string,
  ): Promise<typeof dataSubjectRequest.$inferSelect> {
    const now = this.now();
    const owned = await this.database
      .select()
      .from(dataSubjectRequest)
      .where(and(eq(dataSubjectRequest.id, requestId), eq(dataSubjectRequest.userId, userId)))
      .limit(1);
    if (!owned[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
    const previous = await this.database
      .select({ id: dataSubjectRequestEvent.id })
      .from(dataSubjectRequestEvent)
      .where(
        and(
          eq(dataSubjectRequestEvent.requestId, requestId),
          eq(dataSubjectRequestEvent.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (previous[0]) return owned[0];
    try {
      const result = await this.database.transaction(async (tx) => {
        const updated = await tx
          .update(dataSubjectRequest)
          .set({
            state: "collecting",
            version: sql`${dataSubjectRequest.version} + 1`,
            deliveryState: "not_delivered",
            updatedAt: now,
          })
          .where(
            and(
              eq(dataSubjectRequest.id, requestId),
              eq(dataSubjectRequest.userId, userId),
              eq(dataSubjectRequest.version, version),
              sql`${dataSubjectRequest.state} in ('ready', 'artifact_expired', 'delivered')`,
            ),
          )
          .returning();
        if (!updated[0]) throw new PrivacyRequestError("REQUEST_VERSION_CONFLICT", 409);
        await tx
          .update(dataExportArtifact)
          .set({ state: "revoked", revokedAt: now })
          .where(
            and(
              eq(dataExportArtifact.requestId, requestId),
              sql`${dataExportArtifact.state} not in ('deleted', 'revoked')`,
            ),
          );
        // A new generation needs runnable collector tasks. Previous completion
        // and retry counts belong to the old generation; retain human decisions.
        await tx
          .update(dataSubjectRequestTask)
          .set({
            status: "pending",
            attempts: 0,
            nextAttemptAt: now,
            collectedAt: null,
            recordCount: null,
            exceptionCode: null,
            redactionCode: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(dataSubjectRequestTask.requestId, requestId),
              sql`${dataSubjectRequestTask.collectorId} is not null`,
            ),
          );
        await tx.insert(dataSubjectRequestEvent).values({
          id: randomUUID(),
          requestId,
          eventType: "generation_requested",
          actorKind: "subject",
          actorId: userId,
          payloadVersion: 1,
          payload: boundedEventPayload({}),
          idempotencyKey,
          createdAt: now,
        });
        return updated;
      });
      const revoked = await this.database
        .select({ storageKey: dataExportArtifact.storageKey })
        .from(dataExportArtifact)
        .where(
          and(eq(dataExportArtifact.requestId, requestId), eq(dataExportArtifact.state, "revoked")),
        );
      if (this.deleteArtifactStorage) {
        for (const artifact of revoked) {
          try {
            await this.deleteArtifactStorage(artifact.storageKey);
          } catch {
            /* cleanup retries later */
          }
        }
      }
      await this.enqueue?.(requestId);
      return result[0];
    } catch (error) {
      if (String(error).toLowerCase().includes("idempotency")) {
        const current = await this.database
          .select()
          .from(dataSubjectRequest)
          .where(eq(dataSubjectRequest.id, requestId))
          .limit(1);
        if (current[0]) return current[0];
      }
      throw error;
    }
  }
}

export function createPrivacyRequestService(
  options: PrivacyRequestServiceOptions = {},
): PrivacyRequestService {
  return new PrivacyRequestService(options);
}
