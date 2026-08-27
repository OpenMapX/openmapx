import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { db } from "../db";
import { adminAuditLog } from "../db/schema";
import { appLogger } from "../services/app-logger.js";
import { safeErrorClass, sanitizeLogMetadata } from "./safe-log-fields.js";

// Sentinel actor id emitted by `requireAdmin`'s loopback short-circuit. Such
// requests have no real user row, so the audit log writes `actorId: null` and
// tags the user-agent so the source is still visible in the audit trail.
const LOOPBACK_ACTOR_ID = "loopback";

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
  // The `actorId` foreign-keys into `user.id`. For the synthetic loopback
  // actor there is no row to reference, so substitute null + a user-agent
  // marker so audit consumers can still distinguish CLI/loopback origin from
  // unauthenticated.
  const baseUa = (entry.request?.headers["user-agent"] as string) ?? null;
  const userAgent = isLoopback ? `${baseUa ?? "unknown"} (loopback)` : baseUa;

  try {
    await db.insert(adminAuditLog).values({
      id: randomUUID(),
      actorId: isLoopback ? null : (entry.actorId ?? null),
      targetId: entry.targetId ?? null,
      targetType: entry.targetType ?? null,
      action: entry.action,
      details:
        entry.details === null || entry.details === undefined
          ? null
          : sanitizeLogMetadata(entry.details),
      ipAddress: entry.request?.ip ?? null,
      userAgent,
    });
  } catch (err) {
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
