import { ACTIVE_REQUEST_STATES, TERMINAL_REQUEST_STATES } from "@openmapx/core/privacy";
import { and, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { dataSubjectRequest } from "../db/schema.js";
import { privacyRetention } from "./settings.js";

/**
 * Delete closed case records once the configured case retention has passed.
 * A closed case stays while the same account has another active request, so
 * its history remains available to that request's export.
 */
export async function runPrivacyDatabaseCleanup(input: {
  database?: typeof defaultDb;
  now?: Date;
}): Promise<{ cases: number }> {
  const database = input.database ?? defaultDb;
  const now = input.now ?? new Date();
  const caseCutoff = new Date(
    now.getTime() - (await privacyRetention("case", database)) * 86_400_000,
  );
  const deleted = await database
    .delete(dataSubjectRequest)
    .where(
      and(
        inArray(dataSubjectRequest.state, [...TERMINAL_REQUEST_STATES]),
        sql`coalesce(${dataSubjectRequest.closedAt}, ${dataSubjectRequest.updatedAt}) < ${caseCutoff.toISOString()}`,
        sql`not exists (select 1 from data_subject_request active where active.id <> ${dataSubjectRequest.id} and active.state in (${sql.join(
          ACTIVE_REQUEST_STATES.map((state) => sql`${state}`),
          sql`, `,
        )}) and active.user_id = ${dataSubjectRequest.userId})`,
      ),
    )
    .returning({ id: dataSubjectRequest.id });
  return { cases: deleted.length };
}
