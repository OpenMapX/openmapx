import { type AuditAction, auditEntry } from "@openmapx/core/api-contracts";
import type { FastifyRequest } from "fastify";
import { currentAccountMutation } from "../account/account-context";
import { currentAuthDatabase } from "../account/auth-database";
import { adminAuditLog } from "../db/schema";
import { appLogger } from "../services/app-logger.js";
import { actorUserIdOrNull } from "./actor.js";
import { safeErrorClass, sanitizeLogMetadata } from "./safe-log-fields.js";

export interface AuditLogEntry {
  actorId?: string | null;
  targetId?: string | null;
  /** The action names its target type in the audit registry. */
  action: AuditAction;
  details?: Record<string, unknown> | null;
  request?: FastifyRequest;
}

export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  const userAgent = entry.request?.headers["user-agent"] ?? null;
  const { action, targetType } = auditEntry(entry.action);

  try {
    await currentAuthDatabase()
      .insert(adminAuditLog)
      .values({
        actorUserId: actorUserIdOrNull(entry.actorId),
        targetId: entry.targetId ?? null,
        targetType,
        targetUserId: targetType === "user" ? actorUserIdOrNull(entry.targetId) : null,
        action,
        details:
          entry.details === null || entry.details === undefined
            ? null
            : { ...sanitizeLogMetadata(entry.details) },
        ipAddress: entry.request?.ip ?? null,
        userAgent,
      });
  } catch (err) {
    if (currentAccountMutation()) throw err;
    // Audit log failures must never break the main operation
    appLogger.add({
      level: "error",
      source: "audit-log",
      message: "Audit log persistence failed",
      time: Date.now(),
      metadata: { errorClass: safeErrorClass(err) },
    });
  }
}
