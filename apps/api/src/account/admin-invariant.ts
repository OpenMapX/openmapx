import { APIError } from "better-auth/api";
import { and, eq, or, sql } from "drizzle-orm";
import { accountAdminGuard, adminJob, user } from "../db/schema";
import { noPendingReceiptDelivery, noUnsettledManagedOperation } from "../services/admin-job-state";
import { currentAccountMutation } from "./account-context";
import { type AuthDatabase, currentAuthDatabase } from "./auth-database";
export function isActiveFullAdmin(value: { role: string | null; banned: boolean | null }) {
  return value.role === "admin" && value.banned !== true;
}
export function lastAdminError() {
  return new APIError("CONFLICT", {
    code: "LAST_ADMIN_REQUIRED",
    message: "At least one active full administrator is required",
  });
}
export async function lockAdminGuard(database: AuthDatabase) {
  const [guard] = await database
    .select()
    .from(accountAdminGuard)
    .where(eq(accountAdminGuard.id, 1))
    .for("update");
  if (!guard) throw Error("Account administration guard unavailable");
  return guard;
}
export async function assertAdminCapacity(
  database: AuthDatabase,
  targetId: string,
  next: { role?: string; banned?: boolean; deleted?: boolean },
) {
  const guard = await lockAdminGuard(database),
    [target] = await database.select().from(user).where(eq(user.id, targetId)).for("update");
  if (!target)
    throw new APIError("NOT_FOUND", { code: "USER_NOT_FOUND", message: "Account not found" });
  const losing =
    isActiveFullAdmin(target) &&
    (next.deleted === true || !isActiveFullAdmin({ ...target, ...next }));
  if (losing && guard.activeCount <= 1) throw lastAdminError();
  return target;
}
export async function assertAccountDeletionAllowed(targetId: string) {
  const context = currentAccountMutation();
  if (!context || context.action !== "delete" || context.database !== currentAuthDatabase())
    throw Error("Account deletion transaction required");
  if (context.targetId !== null && context.targetId !== targetId)
    throw Error("Account deletion target changed");
  await assertAdminCapacity(context.database, targetId, { deleted: true });
  // That existing guard holds the target user FOR UPDATE. New actor-attributed
  // job inserts need the FK's KEY SHARE lock, so none can slip past this check
  // before deletion commits. Pending private input must survive cancellation.
  const [pending] = await context.database
    .select({ id: adminJob.id })
    .from(adminJob)
    .where(
      and(
        or(
          eq(adminJob.createdBy, targetId),
          sql`${adminJob.result}->>'_immediateActorId' = ${targetId}`,
        ),
        or(
          sql`${adminJob.status} NOT IN ('success','failed','canceled')`,
          sql`${adminJob.finishedAt} IS NULL`,
          sql`NOT (${noPendingReceiptDelivery()})`,
          sql`NOT (${noUnsettledManagedOperation()})`,
          sql`${adminJob.result}->'_configurationCandidate' IS NOT NULL AND coalesce(${adminJob.result}->'_configurationCandidate'->>'phase','unknown') NOT IN ('settled','discarded')`,
        ),
      ),
    )
    .limit(1);
  if (pending)
    throw new APIError("CONFLICT", {
      code: "ADMIN_OPERATION_IN_PROGRESS",
      message:
        "Finish or cancel this administrator's instance operations in Activity before deleting the account",
    });
}
export function mapAccountConstraint(error: unknown): never {
  let current = error;
  for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
    const item = current as { constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (item.constraint_name === "LAST_ADMIN_REQUIRED" || item.constraint === "LAST_ADMIN_REQUIRED")
      throw lastAdminError();
    current = item.cause;
  }
  throw error;
}
