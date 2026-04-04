import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { db } from "../db";
import { adminAuditLog } from "../db/schema";

export interface AuditLogEntry {
  actorId?: string | null;
  targetId?: string | null;
  targetType?: string | null;
  action: string;
  details?: Record<string, unknown> | null;
  request?: FastifyRequest;
}

export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      id: randomUUID(),
      actorId: entry.actorId ?? null,
      targetId: entry.targetId ?? null,
      targetType: entry.targetType ?? null,
      action: entry.action,
      details: entry.details ?? null,
      ipAddress: entry.request?.ip ?? null,
      userAgent: (entry.request?.headers["user-agent"] as string) ?? null,
    });
  } catch (err) {
    // Audit log failures must never break the main operation
    console.error("[audit-log] Failed to write entry:", err);
  }
}
