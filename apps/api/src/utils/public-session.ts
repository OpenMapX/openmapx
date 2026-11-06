import type { auth } from "../auth";

type BetterAuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

import type { PublicSessionPayload } from "@openmapx/core/api-contracts";

export type { PublicSessionPayload, PublicSessionUser } from "@openmapx/core/api-contracts";

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
