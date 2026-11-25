/** An audit row as administrators see it. `targetUserId` repeats `targetId`
 * for a user target and exists so that deleting the account clears it, so it
 * stays out of the administration responses. The acting account is `actorId`
 * in the administration API. */
export function adminAuditEntry<
  T extends { actorUserId: string | null; targetUserId: string | null },
>(row: T): Omit<T, "actorUserId" | "targetUserId"> & { actorId: string | null } {
  const { actorUserId, targetUserId: _erasureReference, ...entry } = row;
  return { ...entry, actorId: actorUserId };
}
