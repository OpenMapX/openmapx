import { createHash, timingSafeEqual } from "node:crypto";
import { type Readable, Transform } from "node:stream";
import {
  bindPrivacyBackupCapability,
  PRIVACY_BACKUP_MAX_BODY_BYTES,
  PRIVACY_BACKUP_MAX_OUTPUT_BYTES,
  PRIVACY_BACKUP_TAR_MEDIA_TYPE,
  type PrivacyBackupCapabilityPayload,
  type PrivacyBackupErrorCode,
  type PrivacyBackupSubjectExportRequest,
  privacyBackupSubjectExportRequestSchema,
  verifyPrivacyBackupCapability,
} from "@openmapx/core/ops";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const FALLBACK_REQUEST_ID = "00000000-0000-4000-8000-000000000000";
const MAX_REPLAY_ENTRIES = 1_024;

export interface TrustedPrivacyBackup {
  backupId: string;
  manifestDigest: string;
  platformVersion: string;
  formatVersion: 2;
  /** True only after the agent has revalidated every declared volume's
   * descriptor, byte count and SHA-256 while holding the backup lock. */
  verified: true;
  /** The callback may hold a descriptor/lock for the lifetime of extraction. */
  release?: () => void | Promise<void>;
}

export interface PrivacyBackupExtractionRouteOptions {
  apiToken: string;
  capabilityKey: Uint8Array;
  enabled?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => Date;
  inspectBackup: (
    request: PrivacyBackupSubjectExportRequest,
    signal: AbortSignal,
  ) => Promise<TrustedPrivacyBackup>;
  runCollector: (
    request: PrivacyBackupSubjectExportRequest,
    backup: TrustedPrivacyBackup,
    signal: AbortSignal,
  ) => Promise<Readable>;
}

export class PrivacyBackupExtractionError extends Error {
  constructor(readonly code: PrivacyBackupErrorCode) {
    super(code);
    this.name = "PrivacyBackupExtractionError";
  }
}

function authMatches(header: unknown, token: string): boolean {
  if (typeof header !== "string" || token.length < 1) return false;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) return false;
  const left = createHash("sha256").update(match[1]).digest();
  const right = createHash("sha256").update(token).digest();
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function requestId(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : FALLBACK_REQUEST_ID;
}

function publicError(
  reply: FastifyReply,
  id: string,
  code: PrivacyBackupErrorCode,
  status: number,
): void {
  reply
    .code(status)
    .header("Cache-Control", "no-store")
    .header("Pragma", "no-cache")
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .send({ version: 1, requestId: id, error: code });
}

function statusFor(code: PrivacyBackupErrorCode): number {
  switch (code) {
    case "authentication_failed":
      return 401;
    case "invalid_request":
      return 400;
    case "capability_invalid":
    case "capability_expired":
    case "capability_replayed":
      return 409;
    case "busy":
      return 409;
    case "not_configured":
      return 503;
    case "backup_unavailable":
    case "backup_digest_changed":
    case "unsupported_collector":
      return 422;
    case "limit_exceeded":
      return 413;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}

function classifyCapability(error: unknown): PrivacyBackupErrorCode {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (message.includes("expired")) return "capability_expired";
  return "capability_invalid";
}

/**
 * Dedicated, single-concurrency streaming endpoint for an already approved
 * backup case.  It is deliberately not registered in the ordinary operations
 * journal: no arbitrary operation or process output can cross this boundary.
 */
export function registerPrivacyBackupExtractionRoute(
  app: FastifyInstance,
  options: PrivacyBackupExtractionRouteOptions,
): void {
  if (options.capabilityKey.byteLength !== 32)
    throw new Error("privacy backup capability key must be 32 bytes");
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? PRIVACY_BACKUP_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000)
    throw new Error("invalid privacy backup timeout");
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > PRIVACY_BACKUP_MAX_OUTPUT_BYTES
  )
    throw new Error("invalid privacy backup output limit");
  const consumed = new Map<string, number>();
  let active = false;

  app.post(
    "/v1/privacy/backup-subject-export",
    { bodyLimit: PRIVACY_BACKUP_MAX_BODY_BYTES, logLevel: "silent" },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, unknown> | undefined;
      const id = requestId(body?.requestId);
      if (!authMatches(request.headers.authorization, options.apiToken)) {
        return publicError(reply, id, "authentication_failed", 401);
      }
      if (options.enabled === false) return publicError(reply, id, "not_configured", 503);
      const parsed = privacyBackupSubjectExportRequestSchema.safeParse(request.body);
      if (!parsed.success) return publicError(reply, id, "invalid_request", 400);
      let capability: PrivacyBackupCapabilityPayload;
      try {
        capability = verifyPrivacyBackupCapability(
          parsed.data.capability,
          options.capabilityKey,
          now(),
        );
      } catch (error) {
        return publicError(
          reply,
          id,
          classifyCapability(error),
          statusFor(classifyCapability(error)),
        );
      }
      if (!bindPrivacyBackupCapability(capability, parsed.data)) {
        return publicError(reply, id, "capability_invalid", 409);
      }
      if (
        parsed.data.subjectLocatorDigest !== undefined &&
        parsed.data.subjectLocatorDigest !== capability.subjectLocatorDigest
      ) {
        return publicError(reply, id, "capability_invalid", 409);
      }
      const current = now().getTime();
      for (const [key, expiry] of consumed) if (expiry <= current) consumed.delete(key);
      if (active) return publicError(reply, id, "busy", 409);
      if (consumed.has(capability.id)) return publicError(reply, id, "capability_replayed", 409);
      if (consumed.size >= MAX_REPLAY_ENTRIES) return publicError(reply, id, "busy", 409);
      consumed.set(capability.id, Date.parse(capability.expiresAt));
      active = true;
      const controller = new AbortController();
      let lease: TrustedPrivacyBackup | undefined;
      let handedOff = false;
      let source: Readable | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          source?.destroy(new PrivacyBackupExtractionError("timeout"));
        }, timeoutMs);
        lease = await options.inspectBackup(parsed.data, controller.signal);
        if (
          lease.backupId !== parsed.data.backupId ||
          lease.manifestDigest !== parsed.data.manifestDigest
        ) {
          throw new PrivacyBackupExtractionError("backup_digest_changed");
        }
        if (
          lease.platformVersion.length < 1 ||
          lease.platformVersion.length > 128 ||
          lease.formatVersion !== 2 ||
          lease.verified !== true
        ) {
          throw new PrivacyBackupExtractionError("unsupported_collector");
        }
        source = await options.runCollector(parsed.data, lease, controller.signal);
        let bytes = 0;
        const bounded = new Transform({
          transform(chunk: Buffer | Uint8Array, _encoding, callback) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > maxOutputBytes) {
              controller.abort();
              callback(new PrivacyBackupExtractionError("limit_exceeded"));
              return;
            }
            callback(null, Buffer.from(chunk));
          },
        });
        const abortOnClose = () => {
          if (!reply.raw.writableEnded) controller.abort();
        };
        request.raw.once("close", abortOnClose);
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (timer !== undefined) clearTimeout(timer);
          request.raw.removeListener("close", abortOnClose);
          active = false;
          void lease?.release?.();
        };
        bounded.once("close", finish);
        bounded.once("error", () => controller.abort());
        source.once("error", (error) => bounded.destroy(error));
        source.pipe(bounded);
        reply
          .header("Content-Type", PRIVACY_BACKUP_TAR_MEDIA_TYPE)
          .header("Cache-Control", "no-store")
          .header("Pragma", "no-cache")
          .header("X-Content-Type-Options", "nosniff")
          .header("Referrer-Policy", "no-referrer");
        handedOff = true;
        return reply.send(bounded);
      } catch (error) {
        controller.abort();
        if (timer !== undefined) clearTimeout(timer);
        source?.destroy();
        await lease?.release?.();
        const code =
          error instanceof PrivacyBackupExtractionError
            ? error.code
            : timedOut || controller.signal.aborted
              ? "timeout"
              : "collector_failed";
        return publicError(reply, id, code, statusFor(code));
      } finally {
        if (!handedOff) active = false;
      }
    },
  );
}
