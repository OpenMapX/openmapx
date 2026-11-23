import type { FastifyRequest } from "fastify";
import { currentAccountMutation } from "../account/account-context";
import { currentAuthDatabase } from "../account/auth-database";
import { adminAuditLog } from "../db/schema";
import { appLogger } from "../services/app-logger.js";
import { actorUserIdOrNull, LOOPBACK_ACTOR_ID } from "./actor.js";
import { safeErrorClass, sanitizeLogMetadata } from "./safe-log-fields.js";

export interface AuditLogEntry {
  actorId?: string | null;
  targetId?: string | null;
  targetType?: string | null;
  action: string;
  details?: Record<string, unknown> | null;
  request?: FastifyRequest;
}

export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  const isLoopback = entry.actorId === LOOPBACK_ACTOR_ID;
  // The synthetic loopback actor has no account row, so its actor id is
  // stored as null; a user-agent marker still tells CLI/loopback origin apart
  // from unauthenticated.
  const baseUa = entry.request?.headers["user-agent"] ?? null;
  const userAgent = isLoopback ? `${baseUa ?? "unknown"} (loopback)` : baseUa;

  try {
    await currentAuthDatabase()
      .insert(adminAuditLog)
      .values({
        actorId: actorUserIdOrNull(entry.actorId),
        targetId: entry.targetId ?? null,
        targetType: entry.targetType ?? null,
        targetUserId: entry.targetType === "user" ? actorUserIdOrNull(entry.targetId) : null,
        action: entry.action,
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
      msg: "Audit log persistence failed",
      time: Date.now(),
      metadata: { errorClass: safeErrorClass(err) },
    });
  }
}
