// The synthetic actor id emitted by `requireAdmin`'s loopback short-circuit
// (CLI / on-host admin calls). Such requests have no `user` row, so every
// column that foreign-keys into `user.id` must store null rather than
// violate the key.
export const LOOPBACK_ACTOR_ID = "loopback";

/** The value to write into a column that references `user.id`: the actor's id,
 * or null for the loopback actor, which has no account row. */
export function actorUserIdOrNull(id: string | null | undefined): string | null {
  return id && id !== LOOPBACK_ACTOR_ID ? id : null;
}
