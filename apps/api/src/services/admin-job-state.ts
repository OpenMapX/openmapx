import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { adminJob } from "../db/schema";

export interface JobExecution {
  owner: string;
  version: number;
}
export class JobOwnershipLost extends Error {
  constructor() {
    super("Administrative job ownership changed");
  }
}
export function readJobExecution(result: unknown): JobExecution | undefined {
  if (
    result !== null &&
    result !== undefined &&
    (typeof result !== "object" || Array.isArray(result))
  )
    throw new JobOwnershipLost();
  const value = (result as { _execution?: JobExecution } | null)?._execution;
  if (value === undefined) return undefined;
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.owner,
    ) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0
  )
    throw new JobOwnershipLost();
  return value;
}
export function jobOwnership(
  id: string,
  execution: JobExecution | undefined,
  statuses = ["running"],
) {
  return and(
    eq(adminJob.id, id),
    inArray(adminJob.status, statuses),
    execution
      ? sql`${adminJob.result}->'_execution' = ${JSON.stringify(execution)}::jsonb`
      : sql`${adminJob.result}->'_execution' IS NULL`,
  );
}
/** Both fields change in one PostgreSQL statement; the old JSON member is the CAS token. */
export async function claimAdminJob(
  job: { id: string; result: unknown; status: string },
  patch: Partial<typeof adminJob.$inferInsert> = {},
  observation = false,
) {
  const previous = readJobExecution(job.result);
  if (previous?.version === Number.MAX_SAFE_INTEGER) throw new JobOwnershipLost();
  const execution = { owner: randomUUID(), version: (previous?.version ?? 0) + 1 };
  const [claimed] = await db
    .update(adminJob)
    .set({
      ...patch,
      result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify({ _execution: execution, ...(observation ? { _observationLeaseUntil: new Date(Date.now() + 60_000).toISOString() } : {}) })}::jsonb`,
    })
    .where(jobOwnership(job.id, previous, [job.status]))
    .returning();
  return claimed;
}
