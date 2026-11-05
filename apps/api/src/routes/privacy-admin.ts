import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { OpsResultFor } from "@openmapx/core/ops";
import { privacyCaseDecisionSchema, privacyCaseExtensionSchema } from "@openmapx/core/privacy";
import { envString } from "@openmapx/core/server-env";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import {
  dataExportArtifact,
  dataExportReauthentication,
  dataSubjectRequest,
  dataSubjectRequestApproval,
  dataSubjectRequestAttachment,
  dataSubjectRequestBackupReview,
  dataSubjectRequestEvent,
  dataSubjectRequestIdentity,
  dataSubjectRequestTask,
  user,
} from "../db/schema.js";
import { privacyCaseProjection as projection } from "../privacy/admin-projections";
import {
  artifactResultFromRow,
  attachmentContentDisposition,
  contentDisposition,
  encryptedBlobResultFromRow,
  parseWrappedDek,
  startArtifactStream,
} from "../privacy/artifact-download.js";
import type { EncryptedBlobStore } from "../privacy/artifact-storage.js";
import { mutateCaseAttachment } from "../privacy/attachment-review";
import { ATTACHMENT_MAX_BYTES, listAttachmentsForRequest } from "../privacy/attachments.js";
import {
  acceptBackupWarnings,
  BackupOmissionReviewError,
  backupOmissionAcceptanceSchema,
  listBackupWarningReviews,
} from "../privacy/backup-omission-review.js";
import {
  backupReviewRequestSchema,
  buildBackupInventory,
  deriveBackupReviewDecision,
} from "../privacy/backup-review.js";
import { SUBJECT_DATA_CATALOGUE } from "../privacy/catalogue";
import { loadMasterKeyRingAsync } from "../privacy/crypto.js";
import { recordSuccessfulArtifactDelivery } from "../privacy/delivery.js";
import {
  EmailChallengeError,
  type PrivacyEmailChallengeSender,
  PrivacyEmailChallengeService,
} from "../privacy/email-challenge.js";
import { generatePrivacyExport } from "../privacy/generation.js";
import {
  findIdempotentEvent,
  idempotencyFingerprint,
  PrivacyIdempotencyError,
  recordIdempotentEvent,
} from "../privacy/idempotency.js";
import type { PrivacyOperationsHealth } from "../privacy/operations-monitor.js";
import { deriveOperatorTaskActions } from "../privacy/operator-task-actions";
import {
  approvalSchema,
  assertApprovalSeparation,
  type GdprExportReadiness,
  type ReadinessImplementationCapabilities,
  type ReadinessReleaseContractChecks,
} from "../privacy/readiness.js";
import { isAssuranceSufficient } from "../privacy/reauthentication";
import { PrivacyReauthenticationService } from "../privacy/reauthentication.js";
import type { ReceiptPreservationDependencies } from "../privacy/receipt-snapshot.js";
import { IMPLEMENTED_PRIVACY_RELEASE_CAPABILITIES } from "../privacy/release-capabilities.js";
import { resolvePrivacyReleaseEvidence } from "../privacy/release-evidence.js";
import { privacyImplementationActorIds } from "../privacy/release-identity.js";
import { resolvePrivacyReleaseValidationChecks } from "../privacy/release-validation.js";
import {
  artifactIdParamSchema,
  assistedReauthStartSchema,
  createSubjectRequestSchema,
  emailIdentityChallengeCompleteSchema,
  emailIdentityChallengeIssueSchema,
  identityReviewSchema,
  isAssistedDeliveryAuthorized,
  reauthCompleteSchema,
  taskAssignmentSchema,
  taskDecisionSchema,
} from "../privacy/request-contracts.js";
import { PrivacyRequestError, PrivacyRequestService } from "../privacy/request-service.js";
import { loadRuntimeGdprExportReadiness } from "../privacy/runtime-readiness.js";
import { getSessionAuthAssurance } from "../privacy/session-assurance.js";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "../services/ops-client.js";
import { sendMail } from "../utils/email.js";
import { getPrivacyAdminSession, requirePrivacyAdmin } from "../utils/require-privacy-admin.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { sendAdminByteResponse } from "./admin-byte-response";
import { registerPrivacyAdminRoute } from "./privacy-admin-contract";
import {
  clearReauthCookie,
  genericReauthFailure,
  parseReauthCookie,
  setReauthCookie,
} from "./privacy-requests.js";

export interface PrivacyAdminRouteOptions {
  service?: PrivacyRequestService;
  artifactStore?: EncryptedBlobStore;
  database?: typeof db;
  operationsHealth?: () => PrivacyOperationsHealth | Promise<PrivacyOperationsHealth>;
  managedDawarichConfigured?: boolean | (() => boolean);
  managedDawarichAvailable?: boolean | (() => boolean);
  releaseEvidenceVersion?: () => Promise<string>;
  implementationCapabilities?: ReadinessImplementationCapabilities;
  releaseContractChecks?: ReadinessReleaseContractChecks;
  releaseReady?: () => boolean | Promise<boolean>;
  readiness?: () => Promise<GdprExportReadiness>;
  emailChallenge?: PrivacyEmailChallengeService;
  sendIdentityChallenge?: PrivacyEmailChallengeSender;
  receiptPreservation?: ReceiptPreservationDependencies;
}
const code = (error: unknown) =>
  error instanceof PrivacyRequestError || error instanceof PrivacyIdempotencyError
    ? error.code
    : "PRIVACY_SERVICE_UNAVAILABLE";
const status = (error: unknown) =>
  error instanceof PrivacyRequestError || error instanceof PrivacyIdempotencyError
    ? error.statusCode
    : 503;
// JSON/base64 adds roughly 4/3 overhead to an encrypted supplement. Keep the
// route-specific parser limit just above the decoded attachment bound rather
// than raising the body limit for every API endpoint.
const ATTACHMENT_BODY_LIMIT = Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 16 * 1024;

function eventProjection(row: {
  eventType: string;
  actorKind: string;
  createdAt: Date;
  payload: unknown;
}) {
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  const safe: Record<string, string> = {};
  for (const key of ["reasonCode", "redactionCode", "kind", "channel", "outcome"]) {
    if (typeof payload[key] === "string" && payload[key].length <= 128)
      safe[key] = payload[key] as string;
  }
  return {
    eventType: row.eventType,
    actorKind: row.actorKind,
    createdAt: row.createdAt,
    ...(Object.keys(safe).length ? { payload: safe } : {}),
  };
}

function eventPayloadValue(event: { payload: unknown } | undefined, key: string): string | null {
  if (!event?.payload || typeof event.payload !== "object" || Array.isArray(event.payload))
    return null;
  const value = (event.payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

type OpsBackupInventory = OpsResultFor<"backup.list">;

function backupRetentionDays(): number {
  const value = Number(process.env.BACKUP_RETENTION_DAYS?.trim() || "30");
  if (!Number.isSafeInteger(value) || value < 1 || value > 36_500)
    throw new Error("invalid backup retention");
  return value;
}

async function loadTrustedBackupInventory(actorId: string): Promise<OpsBackupInventory> {
  const client = createApiOpsClient();
  return executeAndWait(
    client,
    { kind: "backup.list" },
    createDurableOpsKey("privacy.backup.list", actorId),
    { signal: AbortSignal.timeout(30_000) },
  );
}

function privacyBackupInventory(entry: OpsBackupInventory["backups"][number], now: Date) {
  // A path-free inventory is useful for diagnostics, but a review may only
  // act on an entry whose descriptor-anchored bytes were re-hashed by the
  // operations agent.  Never turn an unverified/legacy listing into a trusted
  // source merely because it contains a manifest digest.
  if (
    entry.corrupt ||
    entry.verified !== true ||
    !entry.manifestDigest ||
    !entry.platformVersion ||
    entry.formatVersion !== 2 ||
    !entry.volumes
  )
    return null;
  const byService = new Map<
    string,
    Array<{ name: string; mode: "tar" | "pg_dump"; sizeBytes: number; sha256?: string }>
  >();
  for (const volume of entry.volumes) {
    const list = byService.get(volume.serviceId) ?? [];
    list.push({
      name: volume.volumeId,
      mode: volume.mode,
      sizeBytes: volume.sizeBytes,
      ...(volume.sha256 ? { sha256: volume.sha256 } : {}),
    });
    byService.set(volume.serviceId, list);
  }
  return buildBackupInventory({
    backupId: entry.backupId,
    manifestDigest: entry.manifestDigest,
    now,
    retentionDays: backupRetentionDays(),
    manifest: {
      formatVersion: entry.formatVersion,
      createdAt: entry.createdAt,
      openmapxVersion: entry.platformVersion,
      services: [...byService.entries()].map(([id, volumes]) => ({ id, volumes })),
    },
  });
}

export const privacyAdminRoute: FastifyPluginAsync<PrivacyAdminRouteOptions> = async (
  fastify,
  options,
) => {
  fastify.addHook("onRoute", (route) => {
    if (route.url.endsWith("/attachments") && route.method === "POST")
      route.bodyLimit = ATTACHMENT_BODY_LIMIT;
  });
  declareRouteAuth(fastify, "privacy_admin");
  fastify.addHook("preHandler", async (request) => {
    request.privacyAdminSession = await requirePrivacyAdmin(request);
  });
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Pragma", "no-cache");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });
  const database = options.database ?? db;
  const currentEvidence = async () =>
    options.releaseEvidenceVersion
      ? {
          version: await options.releaseEvidenceVersion(),
          controllerContactConfigured: true,
          sourceBuildFingerprint: "0".repeat(64),
        }
      : resolvePrivacyReleaseEvidence(database);
  const implementationCapabilities =
    options.implementationCapabilities ?? IMPLEMENTED_PRIVACY_RELEASE_CAPABILITIES;
  const managedDawarichAvailable = () =>
    typeof options.managedDawarichAvailable === "function"
      ? options.managedDawarichAvailable()
      : options.managedDawarichAvailable === true;
  const managedDawarichConfigured = () =>
    typeof options.managedDawarichConfigured === "function"
      ? options.managedDawarichConfigured()
      : (options.managedDawarichConfigured ?? options.managedDawarichAvailable !== undefined);
  const runtimeReadiness = async () => {
    const evidence = await currentEvidence();
    const releaseContractChecks =
      options.releaseContractChecks ??
      (await resolvePrivacyReleaseValidationChecks(evidence.sourceBuildFingerprint));
    return loadRuntimeGdprExportReadiness({
      database,
      evidence,
      implementationActorIds: privacyImplementationActorIds(),
      capabilities: implementationCapabilities,
      health: (await options.operationsHealth?.()) ?? {
        monitorHealthy: false,
        cleanupHealthy: false,
        notificationHealthy: false,
        keyReady: false,
        storageHealthy: false,
        backupCapability: false,
        lastRunAt: null,
        lastErrorCode: "operations-health-unavailable",
      },
      artifactStorageBackupDisabled: process.env.PRIVACY_ARTIFACT_BACKUP_DISABLED === "true",
      managedDawarichConfigured: managedDawarichConfigured(),
      managedDawarichAvailable: managedDawarichAvailable(),
      contractChecks: releaseContractChecks,
    });
  };
  const readiness = options.readiness ?? runtimeReadiness;
  const artifactStore = options.artifactStore;
  const serviceForRequest = () =>
    options.service ??
    new PrivacyRequestService({
      database,
      receiptPreservation: options.receiptPreservation,
      deleteArtifactStorage: artifactStore ? (key) => artifactStore.delete(key) : undefined,
    });
  let emailChallengePromise: Promise<PrivacyEmailChallengeService> | undefined;
  const emailChallengeForRequest = () => {
    if (options.emailChallenge) return Promise.resolve(options.emailChallenge);
    emailChallengePromise ??= loadMasterKeyRingAsync().then(
      (keyRing) =>
        new PrivacyEmailChallengeService(
          database,
          keyRing,
          envString("OPENMAPX_DEPLOYMENT_ID", "openmapx"),
        ),
    );
    return emailChallengePromise;
  };

  const requireMutationKey = (request: {
    headers: { [key: string]: string | string[] | undefined };
  }): string => {
    const raw = request.headers["idempotency-key"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/.test(value))
      throw new PrivacyRequestError("IDEMPOTENCY_KEY_REQUIRED", 400);
    return value;
  };

  const assistedDeliveryAuthorized = async (
    requestId: string,
    channel: "assisted" | "representative",
  ): Promise<boolean> => {
    const identities = await database
      .select({
        party: dataSubjectRequestIdentity.party,
        state: dataSubjectRequestIdentity.state,
        authorityState: dataSubjectRequestIdentity.authorityState,
        deliveryAuthorized: dataSubjectRequestIdentity.deliveryAuthorized,
      })
      .from(dataSubjectRequestIdentity)
      .where(eq(dataSubjectRequestIdentity.requestId, requestId));
    return isAssistedDeliveryAuthorized(identities, channel);
  };

  registerPrivacyAdminRoute<{ Querystring: { limit: number; cursor?: string } }>(
    fastify,
    "listPrivacyAdminOperators",
    async (request, reply) => {
      let cursor: string | undefined;
      if (request.query.cursor) {
        try {
          cursor = Buffer.from(request.query.cursor, "base64url").toString("utf8");
          if (
            !cursor ||
            cursor.length > 256 ||
            Buffer.from(cursor).toString("base64url") !== request.query.cursor
          )
            throw Error();
        } catch {
          return reply.status(400).send({ code: "INVALID_OPERATOR_CURSOR" });
        }
      }
      const operators = await database
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(
          and(
            sql`${user.role} in ('admin','privacy_admin')`,
            sql`(${user.banned} is not true or ${user.banExpires} <= now())`,
            cursor ? sql`${user.id} > ${cursor}` : sql`true`,
            sql`${user.id} <> 'loopback'`,
          ),
        )
        .orderBy(asc(user.id))
        .limit(request.query.limit + 1);
      const more = operators.length > request.query.limit;
      const page = operators.slice(0, request.query.limit);
      return reply.send({
        operators: page,
        nextCursor: more ? Buffer.from(page.at(-1)!.id).toString("base64url") : null,
      });
    },
  );
  registerPrivacyAdminRoute<{ Params: { requestId: string } }>(
    fastify,
    "listPrivacyAdminBackupReviews",
    async (request, reply) => {
      const reviews = await database
        .select()
        .from(dataSubjectRequestBackupReview)
        .where(eq(dataSubjectRequestBackupReview.requestId, request.params.requestId))
        .orderBy(asc(dataSubjectRequestBackupReview.reviewedAt));
      return reply.send({ reviews });
    },
  );
  registerPrivacyAdminRoute(fastify, "listPrivacyAdminQueue", async (_request, reply) => {
    const rows = await database
      .select()
      .from(dataSubjectRequest)
      .where(sql`${dataSubjectRequest.state} not in ('closed', 'withdrawn', 'refused')`)
      .orderBy(asc(dataSubjectRequest.dueAt));
    return reply.send({
      requests: rows.map((row) => projection(row as unknown as Record<string, unknown>)),
    });
  });

  registerPrivacyAdminRoute(fastify, "listPrivacyAdminBackups", async (request, reply) => {
    try {
      const actor = getPrivacyAdminSession(request).user.id;
      const inventory = await loadTrustedBackupInventory(actor);
      const now = new Date();
      const backups = inventory.backups.map((entry) => {
        const trusted = privacyBackupInventory(entry, now);
        return (
          trusted ?? {
            backupId: entry.backupId,
            createdAt: entry.createdAt,
            platformVersion: entry.platformVersion ?? null,
            formatVersion: entry.formatVersion ?? null,
            manifestDigest: entry.manifestDigest ?? null,
            verified: false,
            expired: false,
            volumes: [],
            unavailableReason: entry.corruptReason ?? "inventory-incomplete",
          }
        );
      });
      return reply.send({ backups, warningCount: inventory.warningCount });
    } catch {
      return reply.status(503).send({ code: "BACKUP_REVIEW_UNAVAILABLE" });
    }
  });

  registerPrivacyAdminRoute(fastify, "getPrivacyAdminReadiness", async (_request, reply) => {
    try {
      return reply.send(await readiness());
    } catch {
      return reply.status(503).send({ code: "PRIVACY_READINESS_UNAVAILABLE" });
    }
  });

  registerPrivacyAdminRoute<{ Params: { requestId: string } }>(
    fastify,
    "getPrivacyAdminCase",
    async (request, reply) => {
      const rows = await database
        .select()
        .from(dataSubjectRequest)
        .where(eq(dataSubjectRequest.id, request.params.requestId))
        .limit(1);
      if (!rows[0]) return reply.status(404).send({ code: "NOT_FOUND" });
      const tasks = await database
        .select({
          id: dataSubjectRequestTask.id,
          taskKey: dataSubjectRequestTask.taskKey,
          registrationId: dataSubjectRequestTask.registrationId,
          source: dataSubjectRequestTask.source,
          required: dataSubjectRequestTask.required,
          status: dataSubjectRequestTask.status,
          attempts: dataSubjectRequestTask.attempts,
          assignedTo: dataSubjectRequestTask.assignedTo,
          cutoffAt: dataSubjectRequestTask.cutoffAt,
          collectedAt: dataSubjectRequestTask.collectedAt,
          recordCount: dataSubjectRequestTask.recordCount,
          exceptionCode: dataSubjectRequestTask.exceptionCode,
          redactionCode: dataSubjectRequestTask.redactionCode,
        })
        .from(dataSubjectRequestTask)
        .where(eq(dataSubjectRequestTask.requestId, request.params.requestId))
        .orderBy(asc(dataSubjectRequestTask.taskKey));
      const events = (
        await database
          .select({
            eventType: dataSubjectRequestEvent.eventType,
            actorKind: dataSubjectRequestEvent.actorKind,
            createdAt: dataSubjectRequestEvent.createdAt,
            payload: dataSubjectRequestEvent.payload,
          })
          .from(dataSubjectRequestEvent)
          .where(eq(dataSubjectRequestEvent.requestId, request.params.requestId))
          .orderBy(asc(dataSubjectRequestEvent.createdAt))
      ).map(eventProjection);
      const attachments = await listAttachmentsForRequest(request.params.requestId, database);
      const identities = await database
        .select({
          party: dataSubjectRequestIdentity.party,
          state: dataSubjectRequestIdentity.state,
          method: dataSubjectRequestIdentity.method,
          authorityState: dataSubjectRequestIdentity.authorityState,
          deliveryAuthorized: dataSubjectRequestIdentity.deliveryAuthorized,
          verifiedAt: dataSubjectRequestIdentity.verifiedAt,
        })
        .from(dataSubjectRequestIdentity)
        .where(eq(dataSubjectRequestIdentity.requestId, request.params.requestId));
      const artifacts = await database
        .select({
          id: dataExportArtifact.id,
          state: dataExportArtifact.state,
          filename: dataExportArtifact.filename,
          mediaType: dataExportArtifact.mediaType,
          plaintextBytes: dataExportArtifact.plaintextBytes,
          expiresAt: dataExportArtifact.expiresAt,
          readyAt: dataExportArtifact.readyAt,
        })
        .from(dataExportArtifact)
        .where(eq(dataExportArtifact.requestId, request.params.requestId));
      let releaseReady = false;
      try {
        releaseReady = (await readiness()).ready;
      } catch {
        /* Failed readiness never grants a capability. */
      }
      const row = rows[0];
      const active = !["withdrawn", "refused", "closed", "delivered", "artifact_expired"].includes(
        row.state,
      );
      const taskDecision = tasks.some(
        (task) => deriveOperatorTaskActions(row, task, SUBJECT_DATA_CATALOGUE).actions.length > 0,
      );
      const delivery = ["ready", "delivered"].includes(row.state);
      const backupRequired = tasks.some(
        (task) =>
          task.registrationId === "backup-retained-copies" &&
          task.required === 1 &&
          task.status !== "not_applicable",
      );
      const backupReviews = backupRequired
        ? await database
            .select({ decision: dataSubjectRequestBackupReview.decision })
            .from(dataSubjectRequestBackupReview)
            .where(eq(dataSubjectRequestBackupReview.requestId, request.params.requestId))
        : [];
      const backupReady =
        !backupRequired ||
        (backupReviews.length > 0 &&
          backupReviews.every((review) => review.decision !== "unavailable"));
      const supplementRequired = tasks.some(
        (task) =>
          task.registrationId === "off-host-processor-sources" &&
          task.required === 1 &&
          task.status !== "not_applicable",
      );
      const supplementReady =
        !supplementRequired ||
        attachments.some(
          (attachment) =>
            ["operator_supplement", "processor_response"].includes(attachment.purpose) &&
            ["approved", "redacted"].includes(attachment.rightsReviewState) &&
            attachment.expiresAt.getTime() > Date.now(),
        );
      const generate =
        backupReady &&
        supplementReady &&
        releaseReady &&
        row.identityState === "verified" &&
        ["collecting", "pending_processor", "operator_review"].includes(row.state) &&
        tasks.length > 0 &&
        tasks.every(
          (task) => task.required === 0 || ["complete", "not_applicable"].includes(task.status),
        );
      const capabilities = {
        identityReview: ["identity_pending", "clarification_needed", "preserving"].includes(
          row.state,
        ),
        taskDecision,
        taskAssignment: [
          "preserving",
          "collecting",
          "pending_processor",
          "operator_review",
          "clarification_needed",
        ].includes(row.state),
        extendDeadline: active && row.state !== "ready",
        caseDecision: active,
        attachmentWrite: active,
        backupReview: active,
        generate,
        assistedDelivery: delivery && isAssistedDeliveryAuthorized(identities, "assisted"),
        representativeDelivery:
          delivery && isAssistedDeliveryAuthorized(identities, "representative"),
        reasons: {
          ...(!generate
            ? { generate: !releaseReady ? "privacy-release-not-ready" : "case-sources-not-ready" }
            : {}),
          ...(!active ? { case: "case-not-active" } : {}),
        },
      };
      return reply.send({
        request: projection(rows[0] as unknown as Record<string, unknown>),
        capabilities,
        tasks: tasks.map((task) => ({
          ...task,
          actions: deriveOperatorTaskActions(row, task, SUBJECT_DATA_CATALOGUE).actions,
        })),
        events,
        identities,
        attachments,
        artifacts,
      });
    },
  );

  registerPrivacyAdminRoute<{ Body: unknown }>(
    fastify,
    "createPrivacyAdminCase",
    async (request, reply) => {
      try {
        const actor = getPrivacyAdminSession(request);
        const idempotencyKey = requireMutationKey(request);
        const body = createSubjectRequestSchema.parse({
          ...((request.body as Record<string, unknown>) ?? {}),
          channel: (request.body as Record<string, unknown>)?.channel ?? "email",
          actorUserId: actor.user.id,
          actorSessionId: actor.session.id,
          idempotencyKey,
        });
        const row = await serviceForRequest().create(body);
        return reply
          .status(202)
          .send({ request: projection(row as unknown as Record<string, unknown>) });
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "reviewPrivacyAdminIdentity",
    async (request, reply) => {
      let idempotencyKey: string;
      try {
        idempotencyKey = requireMutationKey(request);
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
      const parsed = identityReviewSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ code: "INVALID_IDENTITY_OUTCOME" });
      try {
        const row = await serviceForRequest().recordIdentityReview({
          requestId: request.params.requestId,
          ...parsed.data,
          actorId: getPrivacyAdminSession(request).user.id,
          idempotencyKey,
        });
        return reply.send({ request: projection(row as unknown as Record<string, unknown>) });
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "issuePrivacyAdminEmailChallenge",
    async (request, reply) => {
      try {
        const idempotencyKey = requireMutationKey(request);
        const parsed = emailIdentityChallengeIssueSchema.parse(request.body);
        const challengeService = await emailChallengeForRequest();
        const challenge = await challengeService.issue({
          requestId: request.params.requestId,
          party: parsed.party,
          actorId: getPrivacyAdminSession(request).user.id,
          idempotencyKey,
        });
        const delivery = await challengeService.dispatchPending({
          sender: options.sendIdentityChallenge ?? sendMail,
          challengeId: challenge.challengeId,
          limit: 1,
        });
        return reply.status(202).send({
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt.toISOString(),
          deliveryState: delivery.sent === 1 ? "sent" : "queued",
        });
      } catch (error) {
        if (error instanceof EmailChallengeError) {
          const statusCode =
            error.code === "CHALLENGE_RATE_LIMITED"
              ? 429
              : error.code === "CHALLENGE_NOT_FOUND"
                ? 404
                : 409;
          return reply.status(statusCode).send({ code: error.code });
        }
        if (error instanceof PrivacyRequestError || error instanceof PrivacyIdempotencyError)
          return reply.status(error.statusCode).send({ code: error.code });
        return reply.status(400).send({ code: "CHALLENGE_INVALID" });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string; challengeId: string }; Body: unknown }>(
    fastify,
    "completePrivacyAdminEmailChallenge",
    async (request, reply) => {
      try {
        const idempotencyKey = requireMutationKey(request);
        const parsed = emailIdentityChallengeCompleteSchema.parse(request.body);
        const result = await (await emailChallengeForRequest()).consume({
          requestId: request.params.requestId,
          challengeId: request.params.challengeId,
          party: parsed.party,
          code: parsed.code,
          actorId: getPrivacyAdminSession(request).user.id,
          idempotencyKey,
        });
        return reply.send(result);
      } catch (error) {
        if (error instanceof EmailChallengeError) {
          const statusCode = error.code === "CHALLENGE_NOT_FOUND" ? 404 : 409;
          return reply.status(statusCode).send({ code: error.code });
        }
        if (error instanceof PrivacyRequestError || error instanceof PrivacyIdempotencyError)
          return reply.status(error.statusCode).send({ code: error.code });
        return reply.status(400).send({ code: "CHALLENGE_INVALID" });
      }
    },
  );

  fastify.post<{ Params: { requestId: string }; Body: { version?: unknown } }>(
    "/privacy/admin/requests/:requestId/verify",
    async (request, reply) => {
      try {
        requireMutationKey(request);
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
      return reply.status(410).send({ code: "IDENTITY_METHOD_REQUIRED" });
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string; taskId: string }; Body: unknown }>(
    fastify,
    "assignPrivacyAdminTask",
    async (request, reply) => {
      let idempotencyKey: string;
      try {
        idempotencyKey = requireMutationKey(request);
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
      const parsed = taskAssignmentSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ code: "INVALID_TASK_ASSIGNMENT" });
      try {
        const row = await serviceForRequest().assignTask({
          requestId: request.params.requestId,
          taskId: request.params.taskId,
          ...parsed.data,
          actorId: getPrivacyAdminSession(request).user.id,
          idempotencyKey,
        });
        return reply.send({ request: projection(row as unknown as Record<string, unknown>) });
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string; taskId: string }; Body: unknown }>(
    fastify,
    "decidePrivacyAdminTask",
    async (request, reply) => {
      let idempotencyKey: string;
      try {
        idempotencyKey = requireMutationKey(request);
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
      const parsed = taskDecisionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ code: "INVALID_TASK_DECISION" });
      try {
        await serviceForRequest().markTask({
          requestId: request.params.requestId,
          taskId: request.params.taskId,
          status: parsed.data.status,
          reasonCode: parsed.data.reasonCode,
          redactionCode: parsed.data.redactionCode,
          recordCount: parsed.data.recordCount,
          requestVersion: parsed.data.version,
          actorId: getPrivacyAdminSession(request).user.id,
          idempotencyKey,
        });
        return reply.send({ ok: true });
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "extendPrivacyAdminCase",
    async (request, reply) => {
      let idempotencyKey: string;
      try {
        idempotencyKey = requireMutationKey(request);
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
      const parsed = privacyCaseExtensionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ code: "INVALID_EXTENSION" });
      const body = parsed.data;
      const version = body.version;
      try {
        const row = await serviceForRequest().recordExtension({
          requestId: request.params.requestId,
          version,
          extendedUntil: new Date(body.extendedUntil),
          extensionNotifiedAt: new Date(body.extensionNotifiedAt),
          reasonCode: body.reasonCode,
          actorId: getPrivacyAdminSession(request).user.id,
          idempotencyKey,
        });
        return reply.send({ request: projection(row as unknown as Record<string, unknown>) });
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "decidePrivacyAdminCase",
    async (request, reply) => {
      let idempotencyKey: string;
      try {
        idempotencyKey = requireMutationKey(request);
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
      const parsed = privacyCaseDecisionSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ code: "INVALID_DECISION" });
      const body = parsed.data;
      const version = body.version;
      try {
        const row = await serviceForRequest().recordDecision({
          requestId: request.params.requestId,
          version,
          decision: body.decision as "refused" | "clarification_needed" | "operator_review",
          reasonCode: body.reasonCode,
          actorId: getPrivacyAdminSession(request).user.id,
          idempotencyKey,
        });
        return reply.send({ request: projection(row as unknown as Record<string, unknown>) });
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "generatePrivacyAdminArtifact",
    async (request, reply) => {
      try {
        const idempotencyKey = requireMutationKey(request);
        const operationDigest = idempotencyFingerprint({ requestId: request.params.requestId });
        const previous = await findIdempotentEvent(database, {
          requestId: request.params.requestId,
          idempotencyKey,
          eventType: "generation_completed",
          operationDigest,
        });
        if (previous) {
          const artifactId = eventPayloadValue(previous, "artifactId");
          if (!artifactId) throw new PrivacyRequestError("IDEMPOTENCY_KEY_REUSED", 409);
          const replay = await database
            .select({ request: dataSubjectRequest, artifact: dataExportArtifact })
            .from(dataExportArtifact)
            .innerJoin(dataSubjectRequest, eq(dataExportArtifact.requestId, dataSubjectRequest.id))
            .where(
              and(
                eq(dataExportArtifact.id, artifactId),
                eq(dataExportArtifact.requestId, request.params.requestId),
              ),
            )
            .limit(1);
          if (!replay[0]) throw new PrivacyRequestError("ARTIFACT_NOT_FOUND", 404);
          return reply.status(201).send({
            request: projection(replay[0].request as unknown as Record<string, unknown>),
            artifact: {
              id: replay[0].artifact.id,
              filename: replay[0].artifact.filename,
              state: replay[0].artifact.state,
              expiresAt: replay[0].artifact.expiresAt,
              plaintextBytes: replay[0].artifact.plaintextBytes,
            },
            outcomes: [],
          });
        }
        const releaseReady = options.releaseReady
          ? await options.releaseReady()
          : (await readiness()).ready;
        if (!releaseReady) throw new PrivacyRequestError("PRIVACY_RELEASE_NOT_READY", 503);
        if (!options.artifactStore)
          return reply.status(503).send({ code: "PRIVACY_SERVICE_UNAVAILABLE" });
        const result = await generatePrivacyExport({
          requestId: request.params.requestId,
          database,
          store: options.artifactStore,
          service: serviceForRequest(),
        });
        await recordIdempotentEvent(database, {
          requestId: request.params.requestId,
          idempotencyKey,
          eventType: "generation_completed",
          actorKind: "privacy_admin",
          actorId: getPrivacyAdminSession(request).user.id,
          payload: { artifactId: result.artifact.id },
          operationDigest,
        });
        return reply.status(201).send({
          request: projection(result.request as unknown as Record<string, unknown>),
          artifact: {
            id: result.artifact.id,
            filename: result.artifact.filename,
            state: result.artifact.state,
            expiresAt: result.artifact.expiresAt,
            plaintextBytes: result.artifact.plaintextBytes,
          },
          outcomes: result.outcomes,
        });
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "uploadPrivacyAdminAttachment",
    async (request, reply) => {
      try {
        const result = await mutateCaseAttachment({
          kind: "upload",
          requestId: request.params.requestId,
          body: request.body,
          actorId: getPrivacyAdminSession(request).user.id,
          idempotencyKey: requireMutationKey(request),
          database,
          store: options.artifactStore,
        });
        return reply.status(201).send({ attachment: result!.attachment });
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
    },
  );
  registerPrivacyAdminRoute<{ Params: { requestId: string; attachmentId: string }; Body: unknown }>(
    fastify,
    "reviewPrivacyAdminAttachment",
    async (request, reply) => {
      try {
        return reply.send(
          await mutateCaseAttachment({
            kind: "review",
            requestId: request.params.requestId,
            attachmentId: request.params.attachmentId,
            body: request.body,
            actorId: getPrivacyAdminSession(request).user.id,
            idempotencyKey: requireMutationKey(request),
            database,
          }),
        );
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
    },
  );

  /**
   * Attachments are an operator-only, passive download surface.  They are not
   * rendered inline and never receive a URL token.  A recent completed login
   * for the acting privacy administrator is required because these files can
   * contain exceptional identity evidence or processor supplements.
   */
  registerPrivacyAdminRoute<{ Params: { requestId: string; attachmentId: string } }>(
    fastify,
    "downloadPrivacyAdminAttachment",
    async (request, reply) => {
      if (request.headers.range) return reply.status(416).send({ code: "RANGE_NOT_SUPPORTED" });
      const actor = getPrivacyAdminSession(request);
      const assurance = await getSessionAuthAssurance(actor.session.id, database);
      if (
        !assurance ||
        !isAssuranceSufficient(assurance.method, actor.user.twoFactorEnabled === true) ||
        assurance.userId !== actor.user.id ||
        assurance.authenticatedAt.getTime() > Date.now() ||
        Date.now() - assurance.authenticatedAt.getTime() > 10 * 60_000
      )
        return genericReauthFailure(reply);
      if (!options.artifactStore)
        return reply.status(503).send({ code: "PRIVACY_SERVICE_UNAVAILABLE" });
      const rows = await database
        .select({
          attachment: dataSubjectRequestAttachment,
          requestState: dataSubjectRequest.state,
        })
        .from(dataSubjectRequestAttachment)
        .innerJoin(
          dataSubjectRequest,
          eq(dataSubjectRequestAttachment.requestId, dataSubjectRequest.id),
        )
        .where(
          and(
            eq(dataSubjectRequestAttachment.id, request.params.attachmentId),
            eq(dataSubjectRequestAttachment.requestId, request.params.requestId),
            isNull(dataSubjectRequestAttachment.deletedAt),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (
        !row ||
        ["withdrawn", "refused", "closed"].includes(row.requestState) ||
        row.attachment.expiresAt.getTime() <= Date.now() ||
        !row.attachment.wrappedDek
      )
        return reply.status(404).send({ code: "NOT_FOUND" });
      let prepared: ReturnType<typeof startArtifactStream> | undefined;
      try {
        const attachment = encryptedBlobResultFromRow(
          {
            requestId: row.attachment.requestId,
            id: row.attachment.id,
            storageKey: row.attachment.storageKey,
            filename: row.attachment.filename,
            mediaType: row.attachment.mediaType,
            plaintextBytes: row.attachment.plaintextBytes,
            encryptedBytes: row.attachment.encryptedBytes,
            plaintextSha256: row.attachment.plaintextSha256,
            ciphertextSha256: row.attachment.ciphertextSha256,
            cipherVersion: 1,
            aadVersion: 1,
            iv: row.attachment.iv,
            tag: row.attachment.tag,
            wrappedDek: row.attachment.wrappedDek,
            masterKeyVersion: row.attachment.masterKeyVersion,
          },
          {
            deploymentId: envString("OPENMAPX_DEPLOYMENT_ID", "openmapx"),
            wrappedDek: parseWrappedDek(row.attachment.wrappedDek),
            purpose: "attachment",
          },
        );
        prepared = startArtifactStream(options.artifactStore, attachment);
        await prepared.verified;
        const currentActor = await requirePrivacyAdmin(request);
        const currentAssurance = await getSessionAuthAssurance(currentActor.session.id, database);
        if (
          currentActor.user.id !== actor.user.id ||
          currentActor.session.id !== actor.session.id ||
          !currentAssurance ||
          currentAssurance.userId !== actor.user.id ||
          !isAssuranceSufficient(
            currentAssurance.method,
            currentActor.user.twoFactorEnabled === true,
          ) ||
          currentAssurance.authenticatedAt.getTime() > Date.now() ||
          Date.now() - currentAssurance.authenticatedAt.getTime() > 10 * 60000
        )
          throw new Error("fresh assurance required");
        // Integrity verification may overlap a delete or expiry. Re-read both
        // the case and this exact live attachment before authorizing any bytes.
        const current = await database
          .select({ state: dataSubjectRequest.state })
          .from(dataSubjectRequest)
          .innerJoin(
            dataSubjectRequestAttachment,
            eq(dataSubjectRequestAttachment.requestId, dataSubjectRequest.id),
          )
          .where(
            and(
              eq(dataSubjectRequest.id, request.params.requestId),
              eq(dataSubjectRequestAttachment.id, request.params.attachmentId),
              isNull(dataSubjectRequestAttachment.deletedAt),
              sql`${dataSubjectRequestAttachment.expiresAt} > now()`,
            ),
          )
          .limit(1);
        if (!current[0] || ["withdrawn", "refused", "closed"].includes(current[0].state))
          throw new Error("attachment no longer available");
        prepared.authorize();
        await database.insert(dataSubjectRequestEvent).values({
          id: randomUUID(),
          requestId: request.params.requestId,
          eventType: "attachment_downloaded",
          actorKind: "privacy_admin",
          actorId: actor.user.id,
          payloadVersion: 1,
          payload: { purpose: row.attachment.purpose },
          createdAt: new Date(),
        });
        reply.header("Content-Type", "application/octet-stream");
        reply.header("Content-Length", String(row.attachment.plaintextBytes));
        reply.header(
          "Content-Disposition",
          attachmentContentDisposition(row.attachment.filename, row.attachment.mediaType),
        );
        reply.header("Cache-Control", "private, no-store");
        reply.header("Pragma", "no-cache");
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Content-Security-Policy", "default-src 'none'");
        reply.header("Referrer-Policy", "no-referrer");
        reply.header("X-Content-Type-Options", "nosniff");
        const abort = new AbortController();
        const disconnect = () => {
          if (!reply.raw.writableFinished) abort.abort(new Error("download disconnected"));
        };
        reply.raw.once("close", disconnect);
        try {
          await sendAdminByteResponse(reply, {
            body: Readable.toWeb(prepared.stream) as ReadableStream<Uint8Array>,
            signal: abort.signal,
            headers: new Headers(
              Object.fromEntries(
                Object.entries(reply.getHeaders())
                  .filter(([, v]) => v !== undefined)
                  .map(([k, v]) => [k, String(v)]),
              ),
            ),
          });
        } finally {
          reply.raw.off("close", disconnect);
        }
        return reply;
      } catch {
        try {
          prepared?.deny(new Error("attachment download failed"));
        } catch {
          /* stream may already be settled */
        }
        return reply.status(404).send({ code: "NOT_FOUND" });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string; attachmentId: string }; Body: unknown }>(
    fastify,
    "deletePrivacyAdminAttachment",
    async (request, reply) => {
      try {
        await mutateCaseAttachment({
          kind: "delete",
          requestId: request.params.requestId,
          attachmentId: request.params.attachmentId,
          body: request.body,
          actorId: getPrivacyAdminSession(request).user.id,
          idempotencyKey: requireMutationKey(request),
          database,
          store: options.artifactStore,
        });
        return reply.status(204).send();
      } catch (error) {
        return reply.status(status(error)).send({ code: code(error) });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "createPrivacyAdminBackupReview",
    async (request, reply) => {
      try {
        const result = await database.transaction(async (tx) => {
          const database = tx as unknown as typeof db;
          const [current] = await tx
            .select()
            .from(dataSubjectRequest)
            .where(eq(dataSubjectRequest.id, request.params.requestId))
            .for("update")
            .limit(1);
          if (!current) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
          const parsed = backupReviewRequestSchema.parse(request.body);
          const idempotencyKey = requireMutationKey(request);
          const operationDigest = idempotencyFingerprint({
            backupId: parsed.backupId,
            actorId: getPrivacyAdminSession(request).user.id,
          });
          const previous = await findIdempotentEvent(database, {
            requestId: request.params.requestId,
            idempotencyKey,
            eventType: "backup_review_recorded",
            operationDigest,
          });
          if (previous) {
            const reviewId = eventPayloadValue(previous, "reviewId");
            if (!reviewId) throw new PrivacyRequestError("IDEMPOTENCY_KEY_REUSED", 409);
            const replay = await database
              .select()
              .from(dataSubjectRequestBackupReview)
              .where(
                and(
                  eq(dataSubjectRequestBackupReview.id, reviewId),
                  eq(dataSubjectRequestBackupReview.requestId, request.params.requestId),
                ),
              )
              .limit(1);
            if (!replay[0]) throw new PrivacyRequestError("BACKUP_REVIEW_NOT_FOUND", 404);
            return { review: replay[0] };
          }
          if (
            ["withdrawn", "refused", "closed", "delivered", "artifact_expired"].includes(
              current.state,
            )
          )
            throw new PrivacyRequestError("BACKUP_REVIEW_NOT_ALLOWED", 409);
          const actor = getPrivacyAdminSession(request).user.id;
          const requests = await database
            .select({
              snapshotAt: dataSubjectRequest.snapshotAt,
              receivedAt: dataSubjectRequest.receivedAt,
            })
            .from(dataSubjectRequest)
            .where(eq(dataSubjectRequest.id, request.params.requestId))
            .limit(1);
          if (!requests[0]) throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
          const inventory = await loadTrustedBackupInventory(actor);
          const source = inventory.backups.find((entry) => entry.backupId === parsed.backupId);
          if (!source) throw new PrivacyRequestError("BACKUP_NOT_FOUND", 404);
          const trusted = privacyBackupInventory(source, new Date());
          const reviewedAt = new Date();
          const fallback = {
            decision: "unavailable" as const,
            reasonCode:
              source.corruptReason === "missing_manifest"
                ? ("corrupt_or_unverified" as const)
                : ("corrupt_or_unverified" as const),
          };
          const derived = trusted
            ? deriveBackupReviewDecision(trusted, {
                cutoffAt: requests[0].snapshotAt ?? requests[0].receivedAt,
                liveSnapshotAt: requests[0].snapshotAt ?? undefined,
                now: reviewedAt,
              })
            : fallback;
          const candidate = {
            requestId: request.params.requestId,
            backupId: source.backupId,
            manifestDigest: trusted?.manifestDigest ?? source.manifestDigest ?? "0".repeat(64),
            createdAt: trusted ? new Date(trusted.createdAt) : reviewedAt,
            platformVersion: trusted?.platformVersion ?? source.platformVersion ?? "unknown",
            decision: derived.decision,
            reasonCode: derived.reasonCode,
            reviewedBy: actor,
            reviewedAt,
          };
          const [inserted] = await database
            .insert(dataSubjectRequestBackupReview)
            .values(candidate)
            .onConflictDoNothing({
              target: [
                dataSubjectRequestBackupReview.requestId,
                dataSubjectRequestBackupReview.backupId,
              ],
            })
            .returning();
          const row = inserted;
          if (!row) {
            const existing = await database
              .select()
              .from(dataSubjectRequestBackupReview)
              .where(
                and(
                  eq(dataSubjectRequestBackupReview.requestId, request.params.requestId),
                  eq(dataSubjectRequestBackupReview.backupId, source.backupId),
                ),
              )
              .limit(1);
            if (!existing[0]) throw new PrivacyRequestError("BACKUP_REVIEW_NOT_FOUND", 503);
            // Reviews are evidence, not mutable cache rows. A second key may
            // never replace the first review with a new actor, timestamp or
            // inventory decision; the caseworker must create a new request if a
            // fresh review is legally necessary.
            throw new PrivacyRequestError("BACKUP_REVIEW_IMMUTABLE", 409);
          }
          await recordIdempotentEvent(database, {
            requestId: request.params.requestId,
            idempotencyKey,
            eventType: "backup_review_recorded",
            actorKind: "privacy_admin",
            actorId: actor,
            payload: { reviewId: row.id },
            operationDigest,
          });
          return { review: row };
        });
        return reply.status(201).send(result);
      } catch (error) {
        return reply.status(error instanceof PrivacyRequestError ? error.statusCode : 400).send({
          code:
            error instanceof PrivacyRequestError || error instanceof PrivacyIdempotencyError
              ? error.code
              : "INVALID_BACKUP_REVIEW",
        });
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string } }>(
    fastify,
    "listPrivacyAdminBackupOmissions",
    async (request, reply) => {
      const reviews = await listBackupWarningReviews(request.params.requestId, database);
      return reply.send({ reviews });
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string }; Body: unknown }>(
    fastify,
    "acceptPrivacyAdminBackupOmissions",
    async (request, reply) => {
      try {
        const parsed = backupOmissionAcceptanceSchema.parse(request.body);
        const idempotencyKey = requireMutationKey(request);
        const actor = getPrivacyAdminSession(request).user.id;
        const review = await acceptBackupWarnings(
          {
            requestId: request.params.requestId,
            requestVersion: parsed.requestVersion,
            idempotencyKey,
            actorId: actor,
            warningsDigest: parsed.warningsDigest,
            reasonCode: parsed.reasonCode,
          },
          database,
        );
        return reply.status(201).send({ review });
      } catch (error) {
        const expected =
          error instanceof PrivacyRequestError || error instanceof BackupOmissionReviewError;
        return reply.status(expected ? error.statusCode : 400).send({
          code: expected ? error.code : "INVALID_BACKUP_OMISSION_REVIEW",
        });
      }
    },
  );

  fastify.post<{ Body: unknown }>("/privacy/admin/approvals", async (request, reply) => {
    try {
      const idempotencyKey = requireMutationKey(request);
      if (getPrivacyAdminSession(request).user.role !== "admin")
        return reply.status(403).send({ code: "FULL_ADMIN_REQUIRED" });
      const actorId = getPrivacyAdminSession(request).user.id;
      // The implementation identity is deployment-controlled.  Never accept
      // it from the approver: doing so would let a client manufacture a
      // second actor and defeat separation of duties.
      const raw =
        request.body && typeof request.body === "object" && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const parsed = approvalSchema.parse({
        ...raw,
        approverUserId: actorId,
        approverRole: "admin",
      });
      if (parsed.version !== (await currentEvidence()).version)
        throw new PrivacyRequestError("EVIDENCE_VERSION_MISMATCH", 409);
      const operationDigest = idempotencyFingerprint({
        scope: parsed.scope,
        version: parsed.version,
        decision: parsed.decision,
        findingsDigest: parsed.findingsDigest ?? null,
        reviewedAt: new Date(parsed.reviewedAt).toISOString(),
        expiresAt: new Date(parsed.expiresAt).toISOString(),
      });
      const previous = await database
        .select()
        .from(dataSubjectRequestApproval)
        .where(eq(dataSubjectRequestApproval.idempotencyKey, idempotencyKey))
        .limit(1);
      if (previous[0]) {
        const previousDigest = idempotencyFingerprint({
          scope: previous[0].scope,
          version: previous[0].version,
          decision: previous[0].decision,
          findingsDigest: previous[0].findingsDigest ?? null,
          reviewedAt: new Date(previous[0].reviewedAt).toISOString(),
          expiresAt: new Date(previous[0].expiresAt).toISOString(),
        });
        if (previousDigest !== operationDigest || previous[0].approverUserId !== actorId)
          throw new PrivacyRequestError("IDEMPOTENCY_KEY_REUSED", 409);
        return reply.status(201).send({ approval: previous[0] });
      }
      const implementationActorIds = privacyImplementationActorIds();
      if (parsed.decision === "approved" && implementationActorIds.length === 0)
        throw new PrivacyRequestError("IMPLEMENTATION_OWNERS_NOT_CONFIGURED", 503);
      for (const implementationActorId of implementationActorIds)
        assertApprovalSeparation(parsed, implementationActorId);
      if (parsed.approverRole !== "admin")
        return reply.status(403).send({ code: "FULL_ADMIN_REQUIRED" });
      const [row] = await database
        .insert(dataSubjectRequestApproval)
        .values({
          scope: parsed.scope,
          version: parsed.version,
          approverUserId: parsed.approverUserId,
          approverRole: parsed.approverRole,
          decision: parsed.decision,
          findingsDigest: parsed.findingsDigest,
          idempotencyKey,
          reviewedAt: new Date(parsed.reviewedAt),
          expiresAt: new Date(parsed.expiresAt),
        })
        .returning();
      if (!row) throw new PrivacyRequestError("APPROVAL_NOT_FOUND", 503);
      return reply.status(201).send({ approval: row });
    } catch (error) {
      return reply.status(error instanceof PrivacyRequestError ? error.statusCode : 400).send({
        code:
          error instanceof PrivacyRequestError || error instanceof PrivacyIdempotencyError
            ? error.code
            : "INVALID_APPROVAL",
      });
    }
  });

  /**
   * Assisted delivery uses the same purpose-bound ceremony as self-service,
   * but binds the challenge to the privacy administrator and records the
   * declared delivery channel/reason.  No archive bytes or recipient address
   * are accepted in this request.
   */
  registerPrivacyAdminRoute<{ Params: { requestId: string; artifactId: string }; Body: unknown }>(
    fastify,
    "startPrivacyAdminReauthentication",
    async (request, reply) => {
      let idempotencyKey: string;
      try {
        idempotencyKey = requireMutationKey(request);
      } catch {
        return genericReauthFailure(reply);
      }
      const parsed = artifactIdParamSchema.safeParse(request.params);
      const startBody = assistedReauthStartSchema.safeParse(request.body);
      const channel = startBody.success ? startBody.data.channel : "assisted";
      const reasonCode = startBody.success ? startBody.data.reasonCode : "";
      if (!parsed.success || !startBody.success) return genericReauthFailure(reply);
      const actor = getPrivacyAdminSession(request);
      try {
        if (!(await assistedDeliveryAuthorized(parsed.data.requestId, channel)))
          return reply.status(409).send({ code: "DELIVERY_IDENTITY_NOT_AUTHORIZED" });
        const challenge = await new PrivacyReauthenticationService(database).start({
          requestId: parsed.data.requestId,
          artifactId: parsed.data.artifactId,
          initiatingAdminUserId: actor.user.id,
          initiatingAdminSessionId: actor.session.id,
          startingSessionId: actor.session.id,
          deliveryChannel: channel,
          mutation: {
            idempotencyKey,
            reasonCode,
            cookie: parseReauthCookie(request.headers.cookie),
          },
        });
        setReauthCookie(
          reply,
          `${challenge.challengeId}.${challenge.nonce.toString("base64url")}`,
          600,
        );
        return reply.send({
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt.toISOString(),
          loginPath: "/auth/privacy/admin",
        });
      } catch (error) {
        if (error instanceof PrivacyRequestError || error instanceof PrivacyIdempotencyError)
          return reply.status(error.statusCode).send({ code: error.code });
        return genericReauthFailure(reply);
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string; artifactId: string }; Body: unknown }>(
    fastify,
    "completePrivacyAdminReauthentication",
    async (request, reply) => {
      let idempotencyKey: string;
      try {
        idempotencyKey = requireMutationKey(request);
      } catch {
        clearReauthCookie(reply);
        return genericReauthFailure(reply);
      }
      const parsed = artifactIdParamSchema.safeParse(request.params);
      const cookie = parseReauthCookie(request.headers.cookie);
      const completeBody = reauthCompleteSchema.safeParse(request.body);
      const challengeId = completeBody.success ? completeBody.data.challengeId : "";
      if (
        !parsed.success ||
        !completeBody.success ||
        !cookie ||
        challengeId !== cookie.challengeId
      ) {
        clearReauthCookie(reply);
        return genericReauthFailure(reply);
      }
      const actor = getPrivacyAdminSession(request);
      const assurance = await getSessionAuthAssurance(actor.session.id, database);
      if (!assurance) {
        clearReauthCookie(reply);
        return genericReauthFailure(reply);
      }
      try {
        await database.transaction(async (tx) => {
          await tx
            .select({ id: dataSubjectRequest.id })
            .from(dataSubjectRequest)
            .where(eq(dataSubjectRequest.id, parsed.data.requestId))
            .for("update");
          const operationDigest = idempotencyFingerprint({
            artifactId: parsed.data.artifactId,
            challengeId: cookie.challengeId,
            actorId: actor.user.id,
            sessionId: actor.session.id,
          });
          const previous = await findIdempotentEvent(tx as unknown as typeof db, {
            requestId: parsed.data.requestId,
            idempotencyKey,
            eventType: "assisted_delivery_reauth_completed",
            operationDigest,
          });
          await new PrivacyReauthenticationService(tx as unknown as typeof db).complete({
            requestId: parsed.data.requestId,
            artifactId: parsed.data.artifactId,
            challengeId: cookie.challengeId,
            nonce: cookie.nonce,
            session: {
              id: actor.session.id,
              userId: actor.user.id,
              authenticatedAt: assurance.authenticatedAt,
              method: assurance.method,
              mfaConfigured: actor.user.twoFactorEnabled === true,
            },
          });
          if (!previous)
            await recordIdempotentEvent(tx as unknown as typeof db, {
              requestId: parsed.data.requestId,
              idempotencyKey,
              eventType: "assisted_delivery_reauth_completed",
              actorKind: "privacy_admin",
              actorId: actor.user.id,
              payload: { challengeId: cookie.challengeId },
              operationDigest,
            });
        });
        // Download consumes this cookie together with the completed challenge.
        // Keep its original expiry; completion must not extend the ceremony.
        return reply.send({ completed: true });
      } catch {
        clearReauthCookie(reply);
        return genericReauthFailure(reply);
      }
    },
  );

  registerPrivacyAdminRoute<{ Params: { requestId: string; artifactId: string } }>(
    fastify,
    "downloadPrivacyAdminArtifact",
    async (request, reply) => {
      const parsed = artifactIdParamSchema.safeParse(request.params);
      if (!parsed.success || request.headers.range)
        return parsed.success
          ? reply.status(416).send({ code: "RANGE_NOT_SUPPORTED" })
          : reply.status(404).send({ code: "NOT_FOUND" });
      const cookie = parseReauthCookie(request.headers.cookie);
      const actor = getPrivacyAdminSession(request);
      if (!cookie || !options.artifactStore) return genericReauthFailure(reply);
      const rows = await database
        .select({ artifact: dataExportArtifact, requestState: dataSubjectRequest.state })
        .from(dataExportArtifact)
        .innerJoin(dataSubjectRequest, eq(dataExportArtifact.requestId, dataSubjectRequest.id))
        .where(
          and(
            eq(dataExportArtifact.id, parsed.data.artifactId),
            eq(dataExportArtifact.requestId, parsed.data.requestId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (
        row?.artifact.state !== "ready" ||
        !["ready", "delivered"].includes(row.requestState) ||
        !row.artifact.wrappedDek ||
        (row.artifact.expiresAt && row.artifact.expiresAt.getTime() <= Date.now())
      )
        return reply.status(404).send({ code: "NOT_FOUND" });
      let prepared: ReturnType<typeof startArtifactStream> | undefined;
      try {
        const artifactRow = row.artifact;
        const wrappedDek = artifactRow.wrappedDek;
        if (!wrappedDek) throw new Error("missing wrapped key");
        const artifact = artifactResultFromRow(artifactRow as never, {
          deploymentId: envString("OPENMAPX_DEPLOYMENT_ID", "openmapx"),
          wrappedDek: parseWrappedDek(wrappedDek),
        });
        prepared = startArtifactStream(options.artifactStore, artifact);
        await prepared.verified;
        const currentActor = await requirePrivacyAdmin(request);
        const currentAssurance = await getSessionAuthAssurance(currentActor.session.id, database);
        if (
          currentActor.user.id !== actor.user.id ||
          currentActor.session.id !== actor.session.id ||
          !currentAssurance ||
          currentAssurance.userId !== actor.user.id ||
          !isAssuranceSufficient(
            currentAssurance.method,
            currentActor.user.twoFactorEnabled === true,
          ) ||
          currentAssurance.authenticatedAt.getTime() > Date.now() ||
          Date.now() - currentAssurance.authenticatedAt.getTime() > 10 * 60000
        )
          throw new Error("fresh assurance required");
        const current = await database
          .select({ state: dataSubjectRequest.state })
          .from(dataSubjectRequest)
          .where(eq(dataSubjectRequest.id, parsed.data.requestId))
          .limit(1);
        if (!current[0] || !["ready", "delivered"].includes(current[0].state))
          throw new Error("artifact no longer available");
        const challengeRows = await database
          .select({ deliveryChannel: dataExportReauthentication.deliveryChannel })
          .from(dataExportReauthentication)
          .where(eq(dataExportReauthentication.id, cookie.challengeId))
          .limit(1);
        const deliveryChannel = challengeRows[0]?.deliveryChannel;
        if (
          (deliveryChannel !== "assisted" && deliveryChannel !== "representative") ||
          !(await assistedDeliveryAuthorized(parsed.data.requestId, deliveryChannel))
        ) {
          prepared.deny(new Error("delivery identity no longer authorized"));
          prepared.stream.destroy();
          return genericReauthFailure(reply);
        }
        const consumed = await new PrivacyReauthenticationService(database).consume({
          challengeId: cookie.challengeId,
          nonce: cookie.nonce,
          sessionId: actor.session.id,
          artifactId: parsed.data.artifactId,
          deliveryChannel: ["assisted", "representative"],
        });
        if (!consumed) {
          prepared.deny(new Error("reauthentication failed"));
          prepared.stream.destroy();
          return genericReauthFailure(reply);
        }
        prepared.authorize();
        reply.raw.once("finish", () => {
          void recordSuccessfulArtifactDelivery(
            {
              requestId: parsed.data.requestId,
              artifactId: parsed.data.artifactId,
              channel: deliveryChannel,
              actorKind: "privacy_admin",
              actorId: actor.user.id,
            },
            database,
          ).catch((error) => request.log.error({ err: error }, "failed to record export delivery"));
        });
        clearReauthCookie(reply);
        reply.header("Content-Type", "application/octet-stream");
        reply.header("Content-Length", String(artifactRow.plaintextBytes ?? ""));
        reply.header(
          "Content-Disposition",
          contentDisposition(artifactRow.filename ?? "openmapx-data-export.zip"),
        );
        reply.header("Cache-Control", "private, no-store");
        reply.header("Pragma", "no-cache");
        reply.header("Referrer-Policy", "no-referrer");
        reply.header("Referrer-Policy", "no-referrer");
        reply.header("X-Content-Type-Options", "nosniff");
        const abort = new AbortController();
        const disconnect = () => {
          if (!reply.raw.writableFinished) abort.abort(new Error("download disconnected"));
        };
        reply.raw.once("close", disconnect);
        try {
          await sendAdminByteResponse(reply, {
            body: Readable.toWeb(prepared.stream) as ReadableStream<Uint8Array>,
            signal: abort.signal,
            headers: new Headers(
              Object.fromEntries(
                Object.entries(reply.getHeaders())
                  .filter(([, v]) => v !== undefined)
                  .map(([k, v]) => [k, String(v)]),
              ),
            ),
          });
        } finally {
          reply.raw.off("close", disconnect);
        }
        return reply;
      } catch {
        try {
          prepared?.deny(new Error("download failed"));
        } catch {
          /* stream may already be settled */
        }
        clearReauthCookie(reply);
        return reply.status(404).send({ code: "NOT_FOUND" });
      }
    },
  );
};
