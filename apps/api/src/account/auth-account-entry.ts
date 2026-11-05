import { randomUUID } from "node:crypto";
import { APIError } from "better-auth/api";
import {
  type AccountMutationIntent,
  accountRoleSchema,
  withAccountMutation,
  writeAuthAccountRole,
} from "./account-mutations";
import { assertAccountRecoveryProof } from "./account-recovery-context";

const paths: Record<
  string,
  { action: AccountMutationIntent["action"]; callback?: boolean; selfService?: boolean }
> = {
  createUser: { action: "create" },
  setUserPassword: { action: "password" },
  "/api/auth/admin/set-user-password": { action: "password" },
  setRole: { action: "role" },
  banUser: { action: "ban" },
  unbanUser: { action: "unban" },
  removeUser: { action: "delete" },
  adminUpdateUser: { action: "profile" },
  deleteUser: { action: "delete", selfService: true },
  deleteUserCallback: { action: "delete", callback: true, selfService: true },
  "/api/auth/admin/create-user": { action: "create" },
  "/api/auth/admin/set-role": { action: "role" },
  "/api/auth/admin/ban-user": { action: "ban" },
  "/api/auth/admin/unban-user": { action: "unban" },
  "/api/auth/admin/remove-user": { action: "delete" },
  "/api/auth/admin/update-user": { action: "profile" },
  "/api/auth/delete-user": { action: "delete", selfService: true },
  "/api/auth/delete-user/callback": { action: "delete", callback: true, selfService: true },
};
export async function accountAuthEntry<T>(
  input: { entry: string; body: unknown; headers?: HeadersInit; internal: boolean },
  readSession: () => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const descriptor = paths[input.entry];
  if (!descriptor) return run();
  const body =
      input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {},
    headers = new Headers(input.headers);
  const mutationKey = headers.get("idempotency-key") ?? randomUUID();
  if (descriptor.action === "profile") {
    const data = body.data;
    if (
      !data ||
      typeof data !== "object" ||
      Object.keys(data).some((k) => k !== "name" && k !== "image")
    )
      throw new APIError("BAD_REQUEST", {
        code: "USE_ACCOUNT_ACTION",
        message: "Use the dedicated account action for protected account fields",
      });
  }
  let role: import("./account-mutations").AccountRole | undefined;
  if (descriptor.action === "role" || descriptor.action === "create") {
    const nested =
      body.data && typeof body.data === "object"
        ? (body.data as Record<string, unknown>).role
        : undefined;
    const candidate = body.role ?? nested ?? "user",
      parsed = accountRoleSchema.safeParse(candidate);
    if (
      !parsed.success ||
      (nested !== undefined && body.role !== undefined && nested !== body.role)
    )
      throw new APIError("BAD_REQUEST", {
        code: "INVALID_ROLE",
        message: "Select one supported account role",
      });
    role = parsed.data;
  }
  const raw = await readSession(),
    actor =
      raw && typeof raw === "object" ? (raw as { user?: { id?: unknown } }).user?.id : undefined,
    actorId = typeof actor === "string" ? actor : null;
  const targetId =
    typeof body.userId === "string" ? body.userId : descriptor.action === "delete" ? actorId : null;
  if (descriptor.action === "password")
    assertAccountRecoveryProof(actorId, targetId, "account.password.set");
  if (descriptor.action === "role") {
    if (!actorId || !targetId || !role)
      throw new APIError("UNAUTHORIZED", {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    const expected = headers.get("x-openmapx-expected-role");
    if (expected !== null && !accountRoleSchema.safeParse(expected).success)
      throw new APIError("BAD_REQUEST", { code: "INVALID_ROLE", message: "Invalid expected role" });
    return writeAuthAccountRole(
      {
        actorId,
        userId: targetId,
        role,
        idempotencyKey: mutationKey,
        ...(expected ? { expectedRole: accountRoleSchema.parse(expected) } : {}),
      },
      run,
    );
  }
  return withAccountMutation(
    {
      actorId,
      targetId,
      action: descriptor.action,
      mutationKey,
      internalCreate: input.internal,
      selfServiceDelete: descriptor.selfService,
    },
    run,
  );
}
