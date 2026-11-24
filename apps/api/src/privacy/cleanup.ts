import { ACTIVE_REQUEST_STATES, TERMINAL_REQUEST_STATES } from "@openmapx/core/privacy";
import { and, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { PRIVACY_ADMIN_NOTIFICATION_TEMPLATES } from "../db/privacy-schema.js";
import { dataSubjectRequest } from "../db/schema.js";
import { privacyRetention } from "./settings.js";

/**
 * Delete closed case records once the configured case retention has passed.
 * A closed case stays while the same account has another active request, so
 * its history remains available to that request's export. It also stays while
 * a staff member who acted on it, or was alerted about it, has an active
 * request: that export lists the staff member's handling of the case.
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
        sql`not exists (select 1 from data_subject_request handler_request where handler_request.state in (${sql.join(
          ACTIVE_REQUEST_STATES.map((state) => sql`${state}`),
          sql`, `,
        )}) and handler_request.user_id is not null and (exists (select 1 from data_subject_request_event handled where handled.request_id = ${dataSubjectRequest.id} and handled.actor_kind = 'admin' and handled.actor_user_id = handler_request.user_id) or exists (select 1 from data_subject_request_notification alert where alert.request_id = ${dataSubjectRequest.id} and alert.template in (${sql.join(
          PRIVACY_ADMIN_NOTIFICATION_TEMPLATES.map((template) => sql`${template}`),
          sql`, `,
        )}) and alert.recipient_user_id = handler_request.user_id)))`,
      ),
    )
    .returning({ id: dataSubjectRequest.id });
  return { cases: deleted.length };
}
