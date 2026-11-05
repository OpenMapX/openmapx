/** Reclaim only expired inert proposals or proven terminal original jobs.
 * Unknown jobs and any undelivered/unsettled effects keep their private inputs. */
import { and, lt, or, sql } from "drizzle-orm";
import type { db } from "../db";
import { adminJob, transitCredentialPreview as preview } from "../db/schema";
import { preservationAllowsDeletion } from "../privacy/preservation";
import { noPendingReceiptDelivery, noUnsettledManagedOperation } from "./admin-job-state";
export async function pruneTransitCredentialPreviews(
  connection: Pick<typeof db, "delete">,
  now = new Date(),
) {
  const matchingJob = sql`${adminJob.payload}->>'operationKey' = ${preview.operationKey} AND ${adminJob.result}->>'_immediateActorId' = ${preview.actorId}`;
  const rows = await connection
    .delete(preview)
    .where(
      and(
        lt(preview.expiresAt, now),
        preservationAllowsDeletion({
          registrationId: "secret-update-attribution",
          candidateTimestamp: preview.createdAt,
          subjectIds: [preview.actorId],
        }),
        or(
          sql`${preview.consumedAt} IS NULL AND NOT EXISTS (SELECT 1 FROM ${adminJob} WHERE ${matchingJob})`,
          sql`EXISTS (SELECT 1 FROM ${adminJob} WHERE ${matchingJob} AND ${adminJob.status} IN ('success','failed','canceled') AND ${adminJob.finishedAt} < ${new Date(now.getTime() - 72 * 3600000).toISOString()}::timestamptz AND ${noPendingReceiptDelivery()} AND ${noUnsettledManagedOperation()} AND (${preview.consumedAt} IS NULL OR (${adminJob.result}->'_configurationCandidate'->>'candidateId' = ${preview.candidateId}::text AND ${adminJob.result}->'transitCredentials'->>'credentialsRevision' = ${preview.credentialsRevision})))`,
        ),
      ),
    )
    .returning({ id: preview.id });
  return rows.length;
}
