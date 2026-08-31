import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { healthHistory } from "../db/schema";

/** Persist a single health check result. */
export async function recordHealthResult(
  serviceId: string,
  status: string,
  responseTime?: number | null,
  error?: string | null,
): Promise<void> {
  await db.insert(healthHistory).values({
    serviceId,
    status,
    responseTime: responseTime ?? null,
    error: error ?? null,
  });
}

/** Aggregate health history into hourly buckets with uptime percentage. */
export async function getTimeline(
  serviceId: string,
  hours = 24,
): Promise<
  Array<{
    hour: string;
    total: number;
    healthy: number;
    uptimePercent: number;
    avgResponseTime: number | null;
  }>
> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const rows = await db
    .select({
      hour: sql<string>`date_trunc('hour', ${healthHistory.checkedAt})`.as("hour"),
      total: sql<number>`count(*)::int`.as("total"),
      healthy: sql<number>`count(*) filter (where ${healthHistory.status} = 'healthy')::int`.as(
        "healthy",
      ),
      avgResponseTime: sql<number | null>`round(avg(${healthHistory.responseTime}))::int`.as(
        "avg_rt",
      ),
    })
    .from(healthHistory)
    .where(and(eq(healthHistory.serviceId, serviceId), gt(healthHistory.checkedAt, since)))
    .groupBy(sql`date_trunc('hour', ${healthHistory.checkedAt})`)
    .orderBy(sql`date_trunc('hour', ${healthHistory.checkedAt})`);

  return rows.map((r) => ({
    hour: r.hour,
    total: r.total,
    healthy: r.healthy,
    uptimePercent: r.total > 0 ? Math.round((r.healthy / r.total) * 100) : 0,
    avgResponseTime: r.avgResponseTime,
  }));
}

/** Delete records older than N days. */
export async function pruneOldRecords(days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(healthHistory)
    .where(lt(healthHistory.checkedAt, cutoff))
    .returning({ id: healthHistory.id });
  return result.length;
}
