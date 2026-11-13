import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { currentFactorEntryHadSession } from "../account/factor-entry-context";
import { db as defaultDb } from "../db/index.js";
import type { SessionAuthMethod } from "../db/privacy-auth-schema.js";
import { sessionAuthAssurance } from "../db/schema.js";

/**
 * The session row is created by Better Auth only after the interactive login
 * endpoint has completed.  This small vocabulary mapper deliberately returns
 * undefined for every endpoint we have not audited; an unknown endpoint must
 * never silently acquire download assurance.
 */
export function assuranceMethodForAuthPath(
  path: string | undefined,
): SessionAuthMethod | undefined {
  const normalized = path?.replace(/^\/api\/auth/, "") ?? "";
  if (normalized === "/sign-in/email" || normalized === "/sign-in/username") return "password";
  if (normalized === "/two-factor/verify-totp") return "password_totp";
  if (normalized === "/two-factor/verify-backup-code") return "password_recovery";
  if (normalized === "/passkey/verify-authentication") return "passkey";
  if (
    normalized === "/sign-in/social" ||
    normalized === "/callback/:id" ||
    normalized.startsWith("/callback/") ||
    normalized === "/one-tap/callback"
  )
    return "federated";

  return undefined;
}

export interface SessionAssuranceDatabase {
  insert: typeof defaultDb.insert;
  update: typeof defaultDb.update;
}

export async function recordSessionAuthAssurance(input: {
  database?: Pick<SessionAssuranceDatabase, "insert">;
  sessionId: string;
  userId: string;
  method: SessionAuthMethod;
  authenticatedAt?: Date;
  originIndependentPasswordLogin?: boolean;
}): Promise<void> {
  const database = input.database ?? defaultDb;
  const authenticatedAt = input.authenticatedAt ?? new Date();
  await database
    .insert(sessionAuthAssurance)
    .values({
      sessionId: input.sessionId,
      userId: input.userId,
      method: input.method,
      authenticatedAt,
      originIndependentPasswordLogin: input.originIndependentPasswordLogin === true,
      createdAt: authenticatedAt,
    })
    .onConflictDoUpdate({
      target: sessionAuthAssurance.sessionId,
      set: {
        userId: input.userId,
        method: input.method,
        authenticatedAt,
        originIndependentPasswordLogin: input.originIndependentPasswordLogin === true,
      },
    });
}

export async function getSessionAuthAssurance(
  sessionId: string,
  database: typeof defaultDb = defaultDb,
): Promise<{
  sessionId: string;
  userId: string | null;
  method: SessionAuthMethod;
  authenticatedAt: Date;
} | null> {
  const rows = await database
    .select({
      sessionId: sessionAuthAssurance.sessionId,
      userId: sessionAuthAssurance.userId,
      method: sessionAuthAssurance.method,
      authenticatedAt: sessionAuthAssurance.authenticatedAt,
    })
    .from(sessionAuthAssurance)
    .where(eq(sessionAuthAssurance.sessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function recordSessionFromAuthContext(
  session: { id: string; userId: string; createdAt?: Date },
  context: { path?: string; body?: unknown } | null | undefined,
  database: Pick<SessionAssuranceDatabase, "insert"> = defaultDb,
): Promise<boolean> {
  const method = assuranceMethodForAuthPath(context?.path);
  if (!method) return false;
  await recordSessionAuthAssurance({
    database,
    sessionId: session.id,
    userId: session.userId,
    method,
    authenticatedAt: session.createdAt ?? new Date(),
    originIndependentPasswordLogin:
      method === "password" ||
      ((method === "password_totp" || method === "password_recovery") &&
        currentFactorEntryHadSession() === false),
  });
  return true;
}

/** How long a sign-in counts as fresh for an export or an admin ceremony. */
export const REAUTH_TTL_MS = 10 * 60_000;

export interface ReauthenticationSession {
  id: string;
  userId: string;
  authenticatedAt: Date;
  method: SessionAuthMethod;
  mfaConfigured: boolean;
}

export function createReauthenticationNonce(): Buffer {
  return randomBytes(32);
}
export function digestReauthenticationNonce(nonce: Buffer | string): string {
  return createHash("sha256").update(nonce).digest("hex");
}
export function nonceMatchesDigest(nonce: Buffer | string, digest: string): boolean {
  const actual = Buffer.from(digestReauthenticationNonce(nonce), "hex");
  const expected = Buffer.from(digest, "hex");
  return expected.byteLength === actual.byteLength && timingSafeEqual(actual, expected);
}

/** A configured second factor must be part of the sign-in itself. A passkey
 * or federated sign-in is a valid ordinary login, but it is no evidence that
 * the account's TOTP or recovery factor was used. */
export function isAssuranceSufficient(method: SessionAuthMethod, mfaConfigured: boolean): boolean {
  return mfaConfigured
    ? method === "password_totp" || method === "password_recovery"
    : method === "password" || method === "passkey" || method === "federated";
}

/**
 * Whether this session comes from a recent interactive sign-in by this user
 * with a sufficient method. A session older than `maxAgeMs`, or one whose
 * sign-in was not recorded, is not fresh.
 */
export async function hasFreshAssurance(
  session: { sessionId: string; userId: string; mfaConfigured: boolean },
  database: typeof defaultDb = defaultDb,
  now: Date = new Date(),
  maxAgeMs = REAUTH_TTL_MS,
): Promise<boolean> {
  const assurance = await getSessionAuthAssurance(session.sessionId, database);
  if (!assurance || assurance.userId !== session.userId) return false;
  if (!isAssuranceSufficient(assurance.method, session.mfaConfigured)) return false;
  const age = now.getTime() - assurance.authenticatedAt.getTime();
  return age >= 0 && age <= maxAgeMs;
}
