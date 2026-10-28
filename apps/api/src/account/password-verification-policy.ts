import type { AuthPolicySnapshot } from "@openmapx/core/api-contracts";
import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { accountRoleSchema } from "./account-mutations";
export function applyPasswordVerificationPolicy(policy: AuthPolicySnapshot) {
  const userHooks: NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["user"]> = {
    create: {
      before: async (user, context) => {
        const role = (user as typeof user & { role?: unknown }).role;
        if (role !== undefined && !accountRoleSchema.safeParse(role).success)
          throw new APIError("BAD_REQUEST", {
            code: "INVALID_ROLE",
            message: "Select one supported account role",
          });
        return context?.path === "/admin/create-user"
          ? { data: { ...user, emailVerified: false } }
          : undefined;
      },
    },
    update: {
      before: async (patch, context) => {
        if (context?.path !== "/email-otp/reset-password") return;
        if (Object.keys(patch).length === 1 && patch.emailVerified === true) return false;
        throw new APIError("BAD_REQUEST", {
          code: "AUTH_POLICY_INVALID",
          message: "Unexpected password reset verification change",
        });
      },
    },
  };
  const before = createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/two-factor/enable" && !policy.twoFaEnabled)
      throw new APIError("FORBIDDEN", {
        code: "TWO_FACTOR_ENROLLMENT_DISABLED",
        message: "Two-factor enrollment is disabled",
      });
    if (
      ctx.path === "/admin/create-user" &&
      typeof ctx.body?.password === "string" &&
      (ctx.body.password.length < policy.passwordMinLength || ctx.body.password.length > 128)
    )
      throw new APIError("BAD_REQUEST", {
        code: "INVALID_PASSWORD",
        message: "Password does not meet the instance policy",
      });
  });
  return { userHooks, before };
}
