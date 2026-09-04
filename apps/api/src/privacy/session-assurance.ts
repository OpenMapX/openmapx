import { eq } from "drizzle-orm";
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
    normalized.startsWith("/oauth2/callback/") ||
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
  database?: typeof defaultDb;
  sessionId: string;
  userId: string;
  method: SessionAuthMethod;
  authenticatedAt?: Date;
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
      createdAt: authenticatedAt,
    })
    .onConflictDoUpdate({
      target: sessionAuthAssurance.sessionId,
      set: { userId: input.userId, method: input.method, authenticatedAt },
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
  database: typeof defaultDb = defaultDb,
): Promise<boolean> {
  const method = assuranceMethodForAuthPath(context?.path);
  if (!method) return false;
  await recordSessionAuthAssurance({
    database,
    sessionId: session.id,
    userId: session.userId,
    method,
    authenticatedAt: session.createdAt ?? new Date(),
  });
  return true;
}
