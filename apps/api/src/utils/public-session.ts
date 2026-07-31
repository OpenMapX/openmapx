import type { auth } from "../auth";

type BetterAuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/**
 * The user fields the session endpoint is allowed to expose. Declared by hand
 * rather than derived from better-auth's user type so that a field added by a
 * library upgrade is excluded until someone deliberately adds it here.
 */
export interface PublicSessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: string | null;
}

/**
 * The full body of the session endpoint. The session row is reduced to its
 * expiry: the row also carries the session `token`, the stored client IP, the
 * user agent and the admin plugin's impersonation marker, none of which any
 * caller needs. The token in particular is the value the signed session cookie
 * is built from, so handing it to a client would put credential material into
 * a place the HttpOnly cookie deliberately keeps it out of.
 */
export interface PublicSessionPayload {
  user: PublicSessionUser;
  session: { expiresAt: string };
}

/**
 * Reduce a better-auth session to the public payload. Every field is copied
 * explicitly; nothing is spread, so upstream additions cannot leak through.
 */
export function toPublicSession(session: BetterAuthSession): PublicSessionPayload {
  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image ?? null,
      role: session.user.role ?? null,
    },
    session: {
      expiresAt: new Date(session.session.expiresAt).toISOString(),
    },
  };
}
