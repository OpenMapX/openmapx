import type { AuthPolicySnapshot } from "@openmapx/core/api-contracts";
import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { accountRoleSchema } from "./account-mutations";

/**
 * Better Auth routes that let a mailbox alone produce a session, or stand in
 * for an enrolled authenticator app. No client uses them. Password reset and
 * email change keep their own email-code routes, and a reset still ends at
 * the ordinary sign-in with its second factor.
 */
const EMAIL_ONLY_SIGN_IN_PATHS = new Set([
  "/sign-in/email-otp",
  "/email-otp/send-verification-otp",
  "/email-otp/verify-email",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
]);

/**
 * The request field that names a new account address, per route. Provider
 * sign-in gives OpenStreetMap and Mapillary accounts `<id>@osm.invalid` and
 * `<id>@mapillary.invalid`, so nobody may claim an address in the reserved
 * `.invalid` domain directly. The refusal comes before any account lookup, so
 * it reads the same whether a placeholder account exists or not.
 */
const NEW_ADDRESS_FIELDS: Readonly<Record<string, string>> = {
  "/sign-up/email": "email",
  "/admin/create-user": "email",
  "/email-otp/request-email-change": "newEmail",
  "/email-otp/change-email": "newEmail",
  "/change-email": "newEmail",
};

export function isReservedInvalidAddress(address: string): boolean {
  const domain = address
    .slice(address.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  return domain === "invalid" || domain.endsWith(".invalid");
}

/** Paths where Better Auth signs someone in on the strength of their email alone. */
const EMAIL_PROVEN_SESSION_PATHS = new Set(["/verify-email", ...EMAIL_ONLY_SIGN_IN_PATHS]);

export function applyPasswordVerificationPolicy(policy: AuthPolicySnapshot) {
  const sessionHooks: NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["session"]> = {
    create: {
      // A verification link still verifies the address, but it does not sign
      // in an account that has enrolled a second factor.
      before: async (session, context) => {
        if (!context?.path || !EMAIL_PROVEN_SESSION_PATHS.has(context.path)) return;
        const owner = (await context.context.internalAdapter.findUserById(session.userId)) as {
          twoFactorEnabled?: boolean | null;
        } | null;
        if (!owner || owner.twoFactorEnabled === true)
          throw new APIError("FORBIDDEN", {
            code: "TWO_FACTOR_REQUIRED",
            message: "Sign in with your password and second factor",
          });
      },
    },
  };
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
    if (EMAIL_ONLY_SIGN_IN_PATHS.has(ctx.path))
      throw new APIError("NOT_FOUND", { code: "NOT_FOUND", message: "Not found" });
    const addressField = NEW_ADDRESS_FIELDS[ctx.path];
    const address = addressField ? ctx.body?.[addressField] : undefined;
    if (typeof address === "string" && isReservedInvalidAddress(address))
      throw new APIError("BAD_REQUEST", { code: "INVALID_EMAIL", message: "Invalid email" });
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
  return { userHooks, sessionHooks, before };
}
