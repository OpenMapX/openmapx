/** The value to write into a column that references `user.id`: the acting
 * account's id, or null when no account acted. */
export function actorUserIdOrNull(id: string | null | undefined): string | null {
  return id || null;
}
