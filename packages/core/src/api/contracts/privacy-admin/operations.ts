import z from "zod/v4";
import {
  assistedReauthStartSchema,
  emailIdentityChallengeCompleteSchema,
  emailIdentityChallengeIssueSchema,
  identityReviewSchema,
  privacyAttachmentReviewSchema,
  privacyAttachmentUploadSchema,
  privacyBackupReviewRequestSchema,
  privacyCaseDecisionSchema,
  privacyCaseExtensionSchema,
  privacyCaseVersionSchema,
  taskAssignmentSchema,
  taskDecisionSchema,
} from "../../../privacy/admin-contracts";
import {
  type AdminOperation,
  adminBytes,
  adminEmpty,
  adminJson,
  adminJsonValueSchema,
  adminTimestampSchema as date,
} from "../admin";
import {
  privacyAdminDetailSchema,
  privacyArtifactViewSchema,
  privacyAttachmentViewSchema,
  privacyBackupOmissionViewSchema,
  privacyBackupReviewViewSchema,
  privacyCaseViewSchema,
  privacyDownloadHeaders,
  privacyErrorSchema,
} from "./common";

const params = z.strictObject({ requestId: z.uuid() });
const task = params.extend({ taskId: z.uuid() });
const attachment = params.extend({ attachmentId: z.uuid() });
const artifact = params.extend({ artifactId: z.uuid() });
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 410, 413, 416, 429, 500, 503].map((s) => [
    s,
    adminJson(privacyErrorSchema),
  ]),
);
const headers = z.object({
  "idempotency-key": z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/),
});
const requestResult = z.strictObject({ request: privacyCaseViewSchema });
const base = "/api/privacy/admin" as const;
const read = <S extends z.ZodType>(path: `/api/${string}`, schema: S, p?: z.ZodType) => ({
  method: "GET" as const,
  path,
  auth: "privacy_admin" as const,
  ...(p ? { request: { params: p } } : {}),
  responses: { ...errors, 200: adminJson(schema) },
});
const write = <S extends z.ZodType>(
  path: `/api/${string}`,
  body: z.ZodType,
  schema: S,
  p: z.ZodType = params,
  success = 200,
) => ({
  method: "POST" as const,
  path,
  auth: "privacy_admin" as const,
  request: { params: p, body, headers },
  responses: { ...errors, [success]: adminJson(schema) },
});
export const privacyAdminOperations = {
  listPrivacyAdminQueue: read(
    `${base}/queue`,
    z.strictObject({ requests: z.array(privacyCaseViewSchema) }),
  ),
  getPrivacyAdminCase: read(`${base}/requests/:requestId`, privacyAdminDetailSchema, params),
  getPrivacyAdminReadiness: read(
    `${base}/readiness`,
    z.object({
      version: z.literal(1),
      ready: z.boolean(),
      checkedAt: date,
      evidenceVersion: z.string(),
      keyRing: z
        .strictObject({ activeVersion: z.number(), availableVersions: z.array(z.number()) })
        .nullable(),
      checks: z.array(
        z.strictObject({
          id: z.string(),
          status: z.enum(["pass", "fail", "warning"]),
          detailCode: z.string(),
        }),
      ),
      approvals: z.array(adminJsonValueSchema),
    }),
  ),
  listPrivacyAdminBackups: read(
    `${base}/backups`,
    z.strictObject({
      backups: z.array(
        z.object({
          backupId: z.string(),
          createdAt: date,
          platformVersion: z.string().nullable(),
          formatVersion: z.number().nullable(),
          manifestDigest: z.string().nullable(),
          verified: z.boolean(),
          expired: z.boolean(),
          unavailableReason: z.string().optional(),
          volumes: z.array(
            z.strictObject({
              serviceId: z.string(),
              volumeId: z.string(),
              mode: z.enum(["tar", "pg_dump"]),
              sizeBytes: z.number(),
              sha256: z.string(),
            }),
          ),
        }),
      ),
      warningCount: z.number(),
    }),
  ),
  listPrivacyAdminOperators: {
    ...read(
      `${base}/operators`,
      z.strictObject({
        operators: z.array(z.strictObject({ id: z.string(), name: z.string() })),
        nextCursor: z.string().nullable(),
      }),
    ),
    request: {
      query: z.strictObject({
        limit: z
          .preprocess(
            (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
            z.number().int().min(1).max(100),
          )
          .default(50),
        cursor: z.string().max(512).optional(),
      }),
    },
  },
  createPrivacyAdminCase: write(
    `${base}/requests`,
    z.strictObject({
      kind: z.enum(["access", "portability", "access_and_portability"]).optional(),
      channel: z.enum(["email", "post", "representative", "internal"]).optional(),
      userId: z.string().nullable().optional(),
      subject: z
        .strictObject({
          locatorType: z.enum([
            "user_id",
            "email",
            "username",
            "erasure_reference",
            "other_reference",
          ]),
          locator: z.string().min(1).max(512),
          accountState: z.enum(["current", "inaccessible", "deleted", "unknown"]),
        })
        .optional(),
      representative: z
        .strictObject({
          contactType: z.enum(["email", "other_reference"]),
          contact: z.string().min(1).max(512),
        })
        .optional(),
      receivedAt: date.optional(),
      locale: z.string().optional(),
      timeZone: z.string().optional(),
    }),
    requestResult,
    z.strictObject({}),
    202,
  ),
  reviewPrivacyAdminIdentity: write(
    `${base}/requests/:requestId/identity`,
    identityReviewSchema,
    requestResult,
  ),
  issuePrivacyAdminEmailChallenge: write(
    `${base}/requests/:requestId/identity/email-challenges`,
    emailIdentityChallengeIssueSchema,
    z.strictObject({
      challengeId: z.uuid(),
      expiresAt: date,
      deliveryState: z.enum(["sent", "queued"]),
    }),
    params,
    202,
  ),
  completePrivacyAdminEmailChallenge: write(
    `${base}/requests/:requestId/identity/email-challenges/:challengeId/complete`,
    emailIdentityChallengeCompleteSchema,
    z.strictObject({ proofId: z.uuid() }),
    params.extend({ challengeId: z.uuid() }),
  ),
  assignPrivacyAdminTask: write(
    `${base}/requests/:requestId/tasks/:taskId/assignment`,
    taskAssignmentSchema,
    requestResult,
    task,
  ),
  decidePrivacyAdminTask: write(
    `${base}/requests/:requestId/tasks/:taskId/decision`,
    taskDecisionSchema,
    z.strictObject({ ok: z.literal(true) }),
    task,
  ),
  extendPrivacyAdminCase: write(
    `${base}/requests/:requestId/extension`,
    privacyCaseExtensionSchema,
    requestResult,
  ),
  decidePrivacyAdminCase: write(
    `${base}/requests/:requestId/decision`,
    privacyCaseDecisionSchema,
    requestResult,
  ),
  generatePrivacyAdminArtifact: write(
    `${base}/requests/:requestId/generate`,
    z.strictObject({}),
    z.strictObject({
      request: privacyCaseViewSchema,
      artifact: privacyArtifactViewSchema,
      outcomes: z.array(adminJsonValueSchema),
    }),
    params,
    201,
  ),
  uploadPrivacyAdminAttachment: write(
    `${base}/requests/:requestId/attachments`,
    privacyAttachmentUploadSchema,
    z.strictObject({ attachment: privacyAttachmentViewSchema }),
    params,
    201,
  ),
  reviewPrivacyAdminAttachment: write(
    `${base}/requests/:requestId/attachments/:attachmentId/review`,
    privacyAttachmentReviewSchema,
    z.strictObject({ request: privacyCaseViewSchema, attachment: privacyAttachmentViewSchema }),
    attachment,
  ),
  deletePrivacyAdminAttachment: {
    ...write(
      `${base}/requests/:requestId/attachments/:attachmentId`,
      privacyCaseVersionSchema,
      z.never(),
      attachment,
    ),
    method: "DELETE",
    responses: { ...errors, 204: adminEmpty() },
  },
  listPrivacyAdminBackupReviews: read(
    `${base}/requests/:requestId/backup-reviews`,
    z.strictObject({ reviews: z.array(privacyBackupReviewViewSchema) }),
    params,
  ),
  createPrivacyAdminBackupReview: write(
    `${base}/requests/:requestId/backup-reviews`,
    privacyBackupReviewRequestSchema,
    z.strictObject({ review: privacyBackupReviewViewSchema }),
    params,
    201,
  ),
  listPrivacyAdminBackupOmissions: read(
    `${base}/requests/:requestId/backup-omissions`,
    z.strictObject({ reviews: z.array(privacyBackupOmissionViewSchema) }),
    params,
  ),
  acceptPrivacyAdminBackupOmissions: write(
    `${base}/requests/:requestId/backup-omissions/accept`,
    z.strictObject({
      requestVersion: z.number().int().positive(),
      warningsDigest: z.string().regex(/^[a-f0-9]{64}$/),
      reasonCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    }),
    z.strictObject({ review: privacyBackupOmissionViewSchema }),
    params,
    201,
  ),
  startPrivacyAdminReauthentication: write(
    `${base}/requests/:requestId/artifacts/:artifactId/reauth/start`,
    assistedReauthStartSchema,
    z.strictObject({
      challengeId: z.uuid(),
      expiresAt: date,
      loginPath: z.literal("/auth/privacy/admin"),
    }),
    artifact,
  ),
  completePrivacyAdminReauthentication: write(
    `${base}/requests/:requestId/artifacts/:artifactId/reauth/complete`,
    z.strictObject({ challengeId: z.uuid() }),
    z.strictObject({ completed: z.literal(true) }),
    artifact,
  ),
  downloadPrivacyAdminArtifact: {
    method: "GET",
    path: `${base}/requests/:requestId/artifacts/:artifactId/download`,
    auth: "privacy_admin",
    request: { params: artifact },
    responses: {
      ...errors,
      200: adminBytes("application/octet-stream", privacyDownloadHeaders, true),
    },
  },
  downloadPrivacyAdminAttachment: {
    method: "GET",
    path: `${base}/requests/:requestId/attachments/:attachmentId/download`,
    auth: "privacy_admin",
    request: { params: attachment },
    responses: {
      ...errors,
      200: adminBytes("application/octet-stream", privacyDownloadHeaders, true),
    },
  },
} as const satisfies Record<string, AdminOperation>;
