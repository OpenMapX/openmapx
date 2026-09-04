import { and, eq, gte, isNull, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { dataSubjectRequestPreservation } from "../db/schema.js";

type PreservationTransaction = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];

export interface PreservationCandidate {
  registrationId: string;
  locatorDigest: string;
  sourceCutoffAt: Date;
  status: string;
  releasedAt: Date | null;
}

export function preservationHoldsCandidate(
  row: PreservationCandidate,
  registrationId: string,
  locatorDigest: string,
  candidateTimestamp: Date,
): boolean {
  return (
    row.registrationId === registrationId &&
    row.locatorDigest === locatorDigest &&
    row.status === "held" &&
    row.releasedAt === null &&
    candidateTimestamp.getTime() <= row.sourceCutoffAt.getTime()
  );
}

export function preservationReleaseTransition(
  status: string,
  releasedAt: Date | null,
  action: "capture" | "release",
): { status: string; released: boolean } {
  if (action === "capture")
    return status === "released"
      ? { status, released: false }
      : { status: "captured", released: false };
  return releasedAt || status === "released"
    ? { status: "released", released: false }
    : { status: "released", released: true };
}

/**
 * SQL guard for a source retention DELETE. Keeping the hold check in the same
 * statement as the delete prevents a capture/release worker from creating a
 * check-then-delete window. Explicit account erasure does not use this guard.
 *
 * The request FK supplies the exact internal user ID. Callers with an opaque
 * or external locator must use a source-specific digest predicate instead of
 * treating this helper as evidence that preservation is enforced.
 */
export function preservationAllowsDeletion(input: {
  registrationId: string;
  candidateTimestamp: SQLWrapper;
  subjectIds: readonly SQLWrapper[];
}): SQL {
  if (input.subjectIds.length === 0)
    throw new Error("A preservation deletion guard requires an exact subject locator");
  const subjectMatch = sql.join(
    input.subjectIds.map((subjectId) => sql`preservation_request.user_id = ${subjectId}`),
    sql` or `,
  );
  return sql`not exists (
    select 1
    from data_subject_request_preservation preservation
    inner join data_subject_request preservation_request
      on preservation_request.id = preservation.request_id
    where preservation.registration_id = ${input.registrationId}
      and preservation.status = 'held'
      and preservation.released_at is null
      and preservation.source_cutoff_at >= ${input.candidateTimestamp}
      and preservation_request.user_id is not null
      and (${subjectMatch})
  )`;
}

/**
 * Serialize request intake with source retention. The lock is deliberately a
 * separate statement: under PostgreSQL READ COMMITTED, a DELETE statement
 * that waited inside a CTE would retain the snapshot taken before the hold
 * committed. The callback's first statement therefore sees the committed
 * preservation rows after acquiring the lock.
 */
export async function withPreservationRetentionLock<T>(
  database: typeof defaultDb,
  callback: (transaction: PreservationTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(1330464848, 1380275027)`);
    return callback(transaction);
  });
}

export async function isSubjectRetentionHeld(input: {
  registrationId: string;
  locatorDigest: string;
  candidateTimestamp: Date;
  database?: typeof defaultDb;
}): Promise<boolean> {
  const database = input.database ?? defaultDb;
  const rows = await database
    .select({ id: dataSubjectRequestPreservation.id })
    .from(dataSubjectRequestPreservation)
    .where(
      and(
        eq(dataSubjectRequestPreservation.registrationId, input.registrationId),
        eq(dataSubjectRequestPreservation.locatorDigest, input.locatorDigest),
        gte(dataSubjectRequestPreservation.sourceCutoffAt, input.candidateTimestamp),
        eq(dataSubjectRequestPreservation.status, "held"),
        isNull(dataSubjectRequestPreservation.releasedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function capturePreservation(input: {
  id: string;
  database?: typeof defaultDb;
}): Promise<void> {
  const database = input.database ?? defaultDb;
  await database
    .update(dataSubjectRequestPreservation)
    .set({ capturedAt: new Date(), status: "captured" })
    .where(
      and(
        eq(dataSubjectRequestPreservation.id, input.id),
        isNull(dataSubjectRequestPreservation.capturedAt),
        isNull(dataSubjectRequestPreservation.releasedAt),
      ),
    );
}

export async function releasePreservation(input: {
  id: string;
  database?: typeof defaultDb;
}): Promise<void> {
  const database = input.database ?? defaultDb;
  await database
    .update(dataSubjectRequestPreservation)
    .set({ releasedAt: new Date(), status: "released" })
    .where(
      and(
        eq(dataSubjectRequestPreservation.id, input.id),
        isNull(dataSubjectRequestPreservation.releasedAt),
      ),
    );
}
