import { defaultLocale, resolveLocale } from "@openmapx/i18n";
import { APIError, getAuthoritativeSessionFromCtx, isAPIError } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { account as accountTable } from "../db/schema";
import { hasFreshAssurance } from "../privacy/session-assurance";
import { sendMail } from "../utils/email";
import { emailChangeNoticeEmail } from "../utils/emailTemplates";
import { type AuthDatabase, currentAuthDatabase } from "./auth-database";

/**
 * Routes that change how the account is reached, or delete it. They need a
 * recent interactive sign-in with a method that also covers a configured
 * second factor, the same rule as the privacy export.
 */
export const FRESH_SIGN_IN_PATHS: ReadonlySet<string> = new Set([
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/unlink-account",
]);

/**
 * Every credential route an administrator impersonation session may not use.
 * Linking a provider needs a recent sign-in only for a provider the account
 * does not have yet; the password and second-factor routes keep the account
 * password as their proof.
 */
export const IMPERSONATION_REFUSED_PATHS: ReadonlySet<string> = new Set([
  ...FRESH_SIGN_IN_PATHS,
  "/link-social",
  "/change-password",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
]);

/**
 * Provider sign-in gives OpenStreetMap and Mapillary accounts
 * `<id>@osm.invalid` and `<id>@mapillary.invalid`, so an address in the
 * reserved `.invalid` domain never reaches a real mailbox.
 */
export function isReservedInvalidAddress(address: string): boolean {
  const domain = address
    .slice(address.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  return domain === "invalid" || domain.endsWith(".invalid");
}

export interface CredentialChangeSession {
  session: { id: string; userId: string; impersonatedBy?: string | null };
  user: { id: string; twoFactorEnabled?: boolean | null };
}

export interface CredentialChangeDeps {
  loadSession(): Promise<CredentialChangeSession | null>;
  isFresh(input: { sessionId: string; userId: string; mfaConfigured: boolean }): Promise<boolean>;
  linkedProviderIds(userId: string): Promise<string[]>;
}

async function needsFreshSignIn(
  request: { path: string; body: unknown },
  userId: string,
  deps: CredentialChangeDeps,
): Promise<boolean> {
  if (FRESH_SIGN_IN_PATHS.has(request.path)) return true;
  if (request.path !== "/link-social") return false;
  // Requesting more scopes from a provider the account already has adds no
  // way into the account, so the contribution flow can upgrade OpenStreetMap
  // access without a new sign-in. A second identity of that provider is
  // refused when its account row would be created.
  const provider = (request.body as { provider?: unknown } | null | undefined)?.provider;
  if (typeof provider !== "string") return true;
  return !(await deps.linkedProviderIds(userId)).includes(provider);
}

/**
 * Refuses credential changes from impersonation sessions, and from sessions
 * without a recent sufficient sign-in on the routes that need one. Other
 * routes pass without a session read; a request without a session passes so
 * the endpoint answers it with its own 401.
 */
export async function enforceCredentialChangePolicy(
  request: { path: string; body: unknown },
  deps: CredentialChangeDeps,
): Promise<void> {
  if (!IMPERSONATION_REFUSED_PATHS.has(request.path)) return;
  const current = await deps.loadSession();
  if (!current) return;
  if (current.session.impersonatedBy)
    throw new APIError("FORBIDDEN", {
      code: "IMPERSONATION_NOT_ALLOWED",
      message: "Not available while impersonating an account",
    });
  if (!(await needsFreshSignIn(request, current.user.id, deps))) return;
  const fresh = await deps.isFresh({
    sessionId: current.session.id,
    userId: current.user.id,
    mfaConfigured: current.user.twoFactorEnabled === true,
  });
  if (!fresh)
    throw new APIError("UNAUTHORIZED", {
      code: "FRESH_SIGN_IN_REQUIRED",
      message: "Sign in again to continue",
    });
}

type AuthMiddlewareContext = Parameters<typeof getAuthoritativeSessionFromCtx>[0];

/** Dependencies backed by a Better Auth middleware context. */
export function credentialChangeDepsFor(ctx: AuthMiddlewareContext): CredentialChangeDeps {
  return {
    loadSession: async () =>
      (await getAuthoritativeSessionFromCtx(ctx)) as CredentialChangeSession | null,
    isFresh: (input) => hasFreshAssurance(input, currentAuthDatabase()),
    linkedProviderIds: async (userId) =>
      (await ctx.context.internalAdapter.findAccounts(userId)).map((row) => row.providerId),
  };
}

/**
 * Database hook for new account rows: an account may hold one identity per
 * provider. Without this, linking an already linked provider (which needs no
 * recent sign-in) could attach a different identity at that provider.
 */
export async function refuseSecondProviderIdentity(
  data: { userId: string; providerId: string; accountId: string },
  database: Pick<AuthDatabase, "select"> = currentAuthDatabase(),
): Promise<false | undefined> {
  const rows = await database
    .select({ accountId: accountTable.accountId })
    .from(accountTable)
    .where(and(eq(accountTable.userId, data.userId), eq(accountTable.providerId, data.providerId)));
  return rows.some((row) => row.accountId !== data.accountId) ? false : undefined;
}

/** The part of a Better Auth after-hook context the email change notice reads. */
export interface EmailChangeNoticeCtx {
  path: string;
  body?: unknown;
  headers?: Headers;
  request?: { headers: Headers };
  context: {
    returned?: unknown;
    session?: { user?: { id?: string; email?: string } | null } | null;
    logger?: { error(message: string, ...args: unknown[]): void };
  };
}

function cookieValue(cookieHeader: string | null | undefined, name: string): string | undefined {
  for (const part of cookieHeader?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The language of the request that changed the address: the web app's
 * `NEXT_LOCALE` cookie, then the first `Accept-Language` tag. These are the
 * sources the Better Auth error translations use; accounts store no locale.
 */
function mailLocale(headers: Headers | undefined): string {
  const cookieLocale = cookieValue(headers?.get("cookie"), "NEXT_LOCALE");
  if (cookieLocale) return resolveLocale(cookieLocale);
  const acceptLanguage = headers?.get("accept-language")?.split(",")[0]?.split(";")[0]?.trim();
  return acceptLanguage ? resolveLocale(acceptLanguage) : defaultLocale;
}

/**
 * Tells the previous address that the account's email address was changed.
 * Runs after a successful change, while the session still carries the old
 * address. The notice names neither the new address nor a link, and a
 * delivery failure is only logged because the change has already been made.
 */
export async function notifyPreviousAddressOfEmailChange(
  ctx: EmailChangeNoticeCtx,
  send: typeof sendMail = sendMail,
): Promise<void> {
  if (ctx.path !== "/email-otp/change-email") return;
  const returned = ctx.context.returned;
  if (isAPIError(returned) || returned instanceof Error) return;
  const userId = ctx.context.session?.user?.id;
  const previous = ctx.context.session?.user?.email;
  if (!userId || !previous || isReservedInvalidAddress(previous)) return;
  const newEmail = (ctx.body as { newEmail?: unknown } | null | undefined)?.newEmail;
  if (String(newEmail ?? "").toLowerCase() === previous.toLowerCase()) return;
  try {
    await send({
      to: previous,
      ...emailChangeNoticeEmail(mailLocale(ctx.headers ?? ctx.request?.headers)),
      disclosure: { userId, operationCode: "auth.email-change.notice" },
    });
  } catch (error) {
    ctx.context.logger?.error("email change notice failed", error);
  }
}
