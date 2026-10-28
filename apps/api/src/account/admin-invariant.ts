import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { accountAdminGuard, user } from "../db/schema";
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
