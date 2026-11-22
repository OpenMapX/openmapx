/** An audit row as administrators see it. `targetUserId` repeats `targetId`
 * for a user target and exists so that deleting the account clears it, so it
 * stays out of the administration responses. */
export function adminAuditEntry<T extends { targetUserId: string | null }>(
  row: T,
): Omit<T, "targetUserId"> {
  const { targetUserId: _erasureReference, ...entry } = row;
  return entry;
}
