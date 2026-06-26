// The synthetic actor id emitted by `requireAdmin`'s loopback short-circuit
// (CLI / on-host admin calls). Such requests have no `user` row, so any column
// that foreign-keys into `user.id` (admin_job.created_by, *.installed_by,
// admin_audit_log.actor_id) must store null rather than FK-violating.
export const LOOPBACK_ACTOR_ID = "loopback";

/** Map a session actor id to a DB-valid `user.id` FK value (null for synthetic actors). */
export function dbActorId(id: string | null | undefined): string | null {
  return id && id !== LOOPBACK_ACTOR_ID ? id : null;
}
