import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import z from "zod/v4";

/**
 * Contract for the case-specific backup extraction channel.  This is
 * intentionally separate from the ordinary operations protocol: the endpoint
 * never accepts a path, image, command, SQL or Docker argument.
 */
export const PRIVACY_BACKUP_PROTOCOL_VERSION = 1 as const;
export const PRIVACY_BACKUP_TAR_MEDIA_TYPE =
  "application/vnd.openmapx.privacy-backup-subject-tar.v1" as const;
export const PRIVACY_BACKUP_MAX_BODY_BYTES = 64 * 1024;
export const PRIVACY_BACKUP_MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
export const PRIVACY_BACKUP_CAPABILITY_TTL_MS = 5 * 60_000;

/**
 * The backup collector is an audited OpenMapX-owned image.  A digest pin is
 * necessary but not sufficient: accepting an arbitrary registry/image here
 * would let deployment configuration replace the collector with an unreviewed
 * program while retaining the same capability contract.
 */
export const PRIVACY_BACKUP_COLLECTOR_IMAGE_PATTERN =
  /^ghcr\.io\/openmapx\/privacy-backup@sha256:[a-f0-9]{64}$/;

export function isPrivacyBackupCollectorImage(value: string): boolean {
  return PRIVACY_BACKUP_COLLECTOR_IMAGE_PATTERN.test(value.trim());
}

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });

function containsUnsafeControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export const privacyBackupSubjectLocatorSchema = z
  .object({
    kind: z.literal("user_id"),
    value: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !containsUnsafeControlCharacters(value), {
        message: "subject locator contains control characters",
      }),
  })
  .strict();

export const privacyBackupSubjectExportRequestSchema = z
  .object({
    version: z.literal(PRIVACY_BACKUP_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
    taskId: z.string().uuid(),
    backupId: id,
    manifestDigest: digest,
    cutoff: timestamp,
    collectorContract: z.literal("openmapx-subject-export-v1"),
    capability: z.string().regex(/^pbcap1\.[A-Za-z0-9_-]{32,4096}\.[A-Za-z0-9_-]{43}$/),
    subjectLocator: privacyBackupSubjectLocatorSchema,
    /** Optional redundant digest for callers that want to prove the body was
     * assembled from the same locator before it reaches the agent. The signed
     * capability remains authoritative; when present this value is checked
     * against the exact private locator and is never logged. */
    subjectLocatorDigest: digest.optional(),
  })
  .strict();
export type PrivacyBackupSubjectExportRequest = z.infer<
  typeof privacyBackupSubjectExportRequestSchema
>;

export const privacyBackupCapabilityPayloadSchema = z
  .object({
    version: z.literal(PRIVACY_BACKUP_PROTOCOL_VERSION),
    id: z.string().uuid(),
    requestId: z.string().uuid(),
    taskId: z.string().uuid(),
    backupId: id,
    manifestDigest: digest,
    /** Digest of the exact locator in the request body.  The locator itself
     * is intentionally not copied into a bearer capability. */
    subjectLocatorDigest: digest,
    cutoff: timestamp,
    collectorContract: z.literal("openmapx-subject-export-v1"),
    issuedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issued = Date.parse(value.issuedAt);
    const expires = Date.parse(value.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "invalid capability lifetime" });
    }
    if (expires - issued > PRIVACY_BACKUP_CAPABILITY_TTL_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "capability lifetime is too long",
      });
    }
  });
export type PrivacyBackupCapabilityPayload = z.infer<typeof privacyBackupCapabilityPayloadSchema>;

export function privacyBackupSubjectLocatorDigest(
  locator: PrivacyBackupSubjectExportRequest["subjectLocator"],
): string {
  const parsed = privacyBackupSubjectLocatorSchema.parse(locator);
  return createHash("sha256")
    .update("openmapx/privacy-backup-subject-locator/v1\0")
    .update(JSON.stringify(parsed))
    .digest("hex");
}

export const PRIVACY_BACKUP_ERROR_CODES = [
  "not_configured",
  "authentication_failed",
  "invalid_request",
  "capability_invalid",
  "capability_expired",
  "capability_replayed",
  "backup_unavailable",
  "backup_digest_changed",
  "unsupported_collector",
  "busy",
  "limit_exceeded",
  "timeout",
  "collector_failed",
] as const;
export type PrivacyBackupErrorCode = (typeof PRIVACY_BACKUP_ERROR_CODES)[number];

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64url(value: string): Buffer {
  const result = Buffer.from(value, "base64url");
  if (!result.length || result.toString("base64url") !== value)
    throw new Error("invalid base64url");
  return result;
}

function signature(payload: string, key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new Error("privacy backup capability key must be 32 bytes");
  return createHmac("sha256", key)
    .update("openmapx/privacy-backup-capability/v1\0")
    .update(payload)
    .digest();
}

export function createPrivacyBackupCapability(
  input: Omit<PrivacyBackupCapabilityPayload, "version" | "id" | "issuedAt" | "expiresAt"> &
    Partial<Pick<PrivacyBackupCapabilityPayload, "id" | "issuedAt" | "expiresAt">>,
  key: Uint8Array,
  now = new Date(),
): string {
  const issuedAt = input.issuedAt ?? now.toISOString();
  const expiresAt =
    input.expiresAt ?? new Date(now.getTime() + PRIVACY_BACKUP_CAPABILITY_TTL_MS).toISOString();
  const payload = privacyBackupCapabilityPayloadSchema.parse({
    version: PRIVACY_BACKUP_PROTOCOL_VERSION,
    id: input.id ?? randomUUID(),
    requestId: input.requestId,
    taskId: input.taskId,
    backupId: input.backupId,
    manifestDigest: input.manifestDigest,
    subjectLocatorDigest: input.subjectLocatorDigest,
    cutoff: input.cutoff,
    collectorContract: input.collectorContract,
    issuedAt,
    expiresAt,
  });
  const encoded = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `pbcap1.${encoded}.${base64url(signature(encoded, key))}`;
}

export function verifyPrivacyBackupCapability(
  value: string,
  key: Uint8Array,
  now = new Date(),
): PrivacyBackupCapabilityPayload {
  const match = /^pbcap1\.([A-Za-z0-9_-]{32,4096})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) throw new Error("invalid capability format");
  const [encoded, encodedSignature] = [match[1], match[2]];
  const actual = signature(encoded, key);
  const expected = fromBase64url(encodedSignature);
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new Error("invalid capability signature");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid capability payload");
  }
  const payload = privacyBackupCapabilityPayloadSchema.parse(parsed);
  const nowMs = now.getTime();
  const issuedMs = Date.parse(payload.issuedAt);
  const expiresMs = Date.parse(payload.expiresAt);
  if (issuedMs > nowMs + 30_000) throw new Error("capability issued in the future");
  if (expiresMs <= nowMs) throw new Error("capability expired");
  if (expiresMs - issuedMs > PRIVACY_BACKUP_CAPABILITY_TTL_MS)
    throw new Error("capability lifetime is too long");
  return payload;
}

export function bindPrivacyBackupCapability(
  capability: PrivacyBackupCapabilityPayload,
  request: Pick<
    PrivacyBackupSubjectExportRequest,
    | "requestId"
    | "taskId"
    | "backupId"
    | "manifestDigest"
    | "cutoff"
    | "collectorContract"
    | "subjectLocator"
  >,
): boolean {
  return (
    capability.requestId === request.requestId &&
    capability.taskId === request.taskId &&
    capability.backupId === request.backupId &&
    capability.manifestDigest === request.manifestDigest &&
    capability.cutoff === request.cutoff &&
    capability.collectorContract === request.collectorContract &&
    capability.subjectLocatorDigest === privacyBackupSubjectLocatorDigest(request.subjectLocator)
  );
}
