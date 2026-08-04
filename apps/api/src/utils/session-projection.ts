/**
 * The session-row fields the session endpoint is allowed to expose. Declared by
 * hand rather than derived from better-auth's session type so that a column
 * added by a library upgrade is excluded until someone deliberately adds it
 * here.
 *
 * Three stored fields are deliberately absent. `token` is the value the signed
 * session cookie is built from, so handing it to a client would put credential
 * material in a place the HttpOnly cookie exists to keep it out. `ipAddress`
 * and `userAgent` are personal data that no caller reads. None of the three is
 * usable as a credential against this API as configured, but there is no reason
 * to publish them and every reason not to.
 */
export interface PublicSessionRow {
  id: string;
  userId: string;
  expiresAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  impersonatedBy: string | null;
}

/**
 * The subset of better-auth's session row this projection reads. Declared
 * structurally rather than imported so this module never has to reference the
 * configured auth instance, which imports it.
 */
interface StoredSessionRow {
  id: string;
  userId: string;
  expiresAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  impersonatedBy?: string | null | undefined;
}

/**
 * Reduce a stored session row to the fields that may leave the server. Every
 * field is copied explicitly; nothing is spread, so upstream additions cannot
 * leak through.
 */
export function projectSessionRow(row: StoredSessionRow): PublicSessionRow {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    impersonatedBy: row.impersonatedBy ?? null,
  };
}

/**
 * Reduce a whole session payload. The user object is passed through by
 * reference and generically, so every field better-auth and its plugins put on
 * it survives unchanged for both browser callers and the server-side helpers
 * that read the session.
 */
export function projectSessionPayload<TUser>(payload: { user: TUser; session: StoredSessionRow }): {
  user: TUser;
  session: PublicSessionRow;
} {
  return {
    user: payload.user,
    session: projectSessionRow(payload.session),
  };
}
