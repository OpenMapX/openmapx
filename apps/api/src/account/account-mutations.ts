import { createHash, randomUUID } from "node:crypto";
import { APIError } from "better-auth/api";
import { and, eq, sql } from "drizzle-orm";
import z from "zod/v4";
import { adminAuditLog, session, user } from "../db/schema";
import {
  type AccountMutationContext,
  currentAccountMutation,
  withAccountMutationContext,
} from "./account-context";
import { assertAdminCapacity, lockAdminGuard, mapAccountConstraint } from "./admin-invariant";
import {
  type AuthDatabase,
  currentAuthDatabase,
  isTransactionalAuthDatabase,
  withAuthDatabase,
} from "./auth-database";
export const accountRoleSchema = z.enum(["user", "admin", "privacy_admin"]);
export type AccountRole = z.infer<typeof accountRoleSchema>;
export interface AccountMutationIntent {
  actorId: string | null;
  targetId: string | null;
  action: AccountMutationContext["action"];
  mutationKey: string;
  role?: AccountRole;
  internalCreate?: boolean;
  selfServiceDelete?: boolean;
}
class MutationResponseRollback extends Error {
  constructor(readonly response: Response) {
    super("Account mutation failed");
  }
}
export async function assertAccountMutationOutcome<T>(value: T): Promise<T> {
  if (value instanceof Response && value.status >= 400) throw new MutationResponseRollback(value);
  return value;
}
export async function withAccountMutation<T>(
  intent: AccountMutationIntent,
  run: (tx: AuthDatabase) => Promise<T>,
  database: AuthDatabase = currentAuthDatabase(),
): Promise<T> {
  const parent = currentAccountMutation();
  const afterCommit: Array<() => Promise<void>> = parent?.afterCommit ?? [];
  const perform = async (tx: AuthDatabase) => {
    await lockAdminGuard(tx);
    if (intent.actorId) {
      const [actor] = await tx.select().from(user).where(eq(user.id, intent.actorId)).for("update");
      if (
        !actor ||
        actor.banned === true ||
        (!(intent.action === "delete" && intent.selfServiceDelete) && actor.role !== "admin")
      )
        throw new APIError("FORBIDDEN", {
          code: "FULL_ADMIN_REQUIRED",
          message: "An active full administrator is required",
        });
    } else if (!(intent.action === "create" && intent.internalCreate))
      throw new APIError("UNAUTHORIZED", {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    if (intent.targetId) {
      await assertAdminCapacity(
        tx,
        intent.targetId,
        intent.action === "delete"
          ? { deleted: true }
          : intent.action === "ban"
            ? { banned: true }
            : intent.action === "role"
              ? { role: intent.role }
              : {},
      );
    }
    return withAuthDatabase(tx, () =>
      withAccountMutationContext(
        {
          database: tx,
          actorId: intent.actorId,
          targetId: intent.targetId,
          action: intent.action,
          mutationKey: intent.mutationKey,
          roleAudit: false,
          afterCommit,
        },
        async () => assertAccountMutationOutcome(await run(tx)),
      ),
    );
  };
  if (parent) {
    if (
      !isTransactionalAuthDatabase() ||
      parent.database !== database ||
      parent.actorId !== intent.actorId ||
      parent.targetId !== intent.targetId ||
      parent.action !== intent.action
    )
      throw Error("Account mutation must remain in its owning transaction");
    // The original owner alone publishes completion after the physical COMMIT.
    // A nested Better Auth operation shares its transaction and completion queue.
    return perform(database);
  }
  if (isTransactionalAuthDatabase())
    throw Error("An owning account mutation is required before entering an auth transaction");
  try {
    const result = await database.transaction(perform);
    for (const complete of afterCommit) await complete().catch(() => {});
    return result;
  } catch (error) {
    if (error instanceof MutationResponseRollback) return error.response as T;
    return mapAccountConstraint(error);
  }
}
interface RoleChange {
  actorId: string;
  userId: string;
  role: AccountRole;
  expectedRole?: AccountRole;
  idempotencyKey: string;
}
async function roleChange<T>(input: RoleChange, tx: AuthDatabase, write: () => Promise<T>) {
  const role = accountRoleSchema.parse(input.role),
    target = await assertAdminCapacity(tx, input.userId, { role });
  if (input.expectedRole !== undefined && (target.role ?? "user") !== input.expectedRole)
    throw new APIError("CONFLICT", {
      code: "ROLE_VERSION_CONFLICT",
      message: "Account role changed; reload before retrying",
    });
  const previousRole = target.role ?? "user",
    changed = previousRole !== role,
    context = currentAccountMutation();
  if (
    !context ||
    context.actorId !== input.actorId ||
    context.targetId !== input.userId ||
    context.action !== "role"
  )
    throw Error("Role transaction required");
  context.roleAudit = true;
  const value = await assertAccountMutationOutcome(await write());
  const [updated] = await tx.select().from(user).where(eq(user.id, input.userId));
  if (updated?.role !== role) throw Error("Role mutation did not commit its requested state");
  if (changed) {
    await tx.delete(session).where(eq(session.userId, input.userId));
    await tx.insert(adminAuditLog).values({
      id: randomUUID(),
      actorId: input.actorId,
      targetId: input.userId,
      targetType: "user",
      action: "user.role.change",
      details: {
        previousRole,
        role,
        mutationDigest: createHash("sha256").update(input.idempotencyKey).digest("hex"),
      },
    });
  }
  return { value, change: { userId: input.userId, role, changed } };
}
/** Both native role updates and Better Auth's authorized writer share this policy/audit transaction. */
export async function changeAccountRole(
  input: RoleChange,
  database: AuthDatabase = currentAuthDatabase(),
) {
  return withAccountMutation(
    {
      actorId: input.actorId,
      targetId: input.userId,
      action: "role",
      mutationKey: input.idempotencyKey,
      role: input.role,
    },
    async (tx) =>
      (
        await roleChange(input, tx, () =>
          tx
            .update(user)
            .set({ role: input.role, updatedAt: new Date() })
            .where(eq(user.id, input.userId))
            .returning(),
        )
      ).change,
    database,
  );
}
export async function writeAuthAccountRole<T>(
  input: RoleChange,
  write: () => Promise<T>,
  database: AuthDatabase = currentAuthDatabase(),
) {
  return withAccountMutation(
    {
      actorId: input.actorId,
      targetId: input.userId,
      action: "role",
      mutationKey: input.idempotencyKey,
      role: input.role,
    },
    async (tx) => (await roleChange(input, tx, write)).value,
    database,
  );
}
