import { and, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { adminAuditLog } from "../db/schema";
import { requireAdmin } from "../utils/require-admin";
import { resolveActors } from "../utils/resolve-actor";
import { declareRouteAuth } from "../utils/route-auth.js";
import { adminIntegrationCredentialsRoute } from "./admin-integration-credentials";
import { adminIntegrationsRoute } from "./admin-integrations";
import { adminOverviewRoute } from "./admin-overview";

interface AuditFilters {
  action?: string;
  targetType?: string;
  targetId?: string;
  actorId?: string;
}

/**
 * Build the drizzle `where` clause shared by the audit-log list endpoint and
 * the audit-log export endpoint, so the two can never drift in how they
 * interpret the `action`/`targetType`/`targetId`/`actorId` filters.
 */
function buildAuditQuery(filters: AuditFilters) {
  const conditions = [];
  if (filters.action) conditions.push(eq(adminAuditLog.action, filters.action));
  if (filters.targetType) conditions.push(eq(adminAuditLog.targetType, filters.targetType));
  if (filters.targetId) conditions.push(eq(adminAuditLog.targetId, filters.targetId));
  if (filters.actorId) conditions.push(eq(adminAuditLog.actorId, filters.actorId));
  return conditions.length ? and(...conditions) : undefined;
}

// Largest synchronous audit-log export. A genuinely unbounded export needs a
// streaming/job design; for now we cap at the most-recent rows and flag
// truncation via the `X-Export-Truncated` response header.
const AUDIT_EXPORT_MAX_ROWS = 10_000;

const AUDIT_CSV_COLUMNS = ["createdAt", "actorId", "action", "targetType", "targetId"] as const;

/** Quote a CSV field per RFC 4180 when it contains a comma, quote, or newline. */
function csvField(value: unknown): string {
  if (value == null) return "";
  const str = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function adminRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request, _reply) => {
    request.adminSession = await requireAdmin(request);
  });

  await app.register(adminOverviewRoute);
  await app.register(adminIntegrationsRoute);
  await app.register(adminIntegrationCredentialsRoute);

  app.get("/admin/audit", async (request) => {
    const {
      action,
      targetType,
      targetId,
      actorId,
      limit = "50",
      offset = "0",
    } = request.query as {
      action?: string;
      targetType?: string;
      targetId?: string;
      actorId?: string;
      limit?: string;
      offset?: string;
    };

    const where = buildAuditQuery({ action, targetType, targetId, actorId });
    const [entries, [countRow]] = await Promise.all([
      db
        .select()
        .from(adminAuditLog)
        .where(where)
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(Math.min(Number(limit), 200))
        .offset(Number(offset)),
      db.select({ total: count() }).from(adminAuditLog).where(where),
    ]);
    const actors = await resolveActors(entries.map((e) => e.actorId));
    return {
      entries: entries.map((e) => ({
        ...e,
        actor: e.actorId ? (actors.get(e.actorId) ?? null) : null,
      })),
      total: countRow?.total ?? 0,
    };
  });

  app.get("/admin/audit/export", async (request, reply) => {
    const { format, action, targetType, targetId, actorId } = request.query as {
      format?: string;
      action?: string;
      targetType?: string;
      targetId?: string;
      actorId?: string;
    };

    const where = buildAuditQuery({ action, targetType, targetId, actorId });
    // Fetch one more than the cap so we can detect (and flag) truncation.
    const rows = await db
      .select()
      .from(adminAuditLog)
      .where(where)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(AUDIT_EXPORT_MAX_ROWS + 1);

    const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
    const entries = truncated ? rows.slice(0, AUDIT_EXPORT_MAX_ROWS) : rows;
    if (truncated) reply.header("X-Export-Truncated", "true");

    const dateStamp = new Date().toISOString().slice(0, 10);
    const isCsv = format === "csv";
    const ext = isCsv ? "csv" : "json";
    reply.header("Content-Disposition", `attachment; filename="audit-log-${dateStamp}.${ext}"`);

    if (isCsv) {
      const header = AUDIT_CSV_COLUMNS.join(",");
      const body = entries
        .map((e) => AUDIT_CSV_COLUMNS.map((col) => csvField(e[col])).join(","))
        .join("\n");
      reply.header("Content-Type", "text/csv; charset=utf-8");
      return reply.send(body ? `${header}\n${body}` : header);
    }

    const actors = await resolveActors(entries.map((e) => e.actorId));
    const enriched = entries.map((e) => ({
      ...e,
      actor: e.actorId ? (actors.get(e.actorId) ?? null) : null,
    }));
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send(JSON.stringify(enriched));
  });
}
