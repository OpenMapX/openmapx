/**
 * Bounded, content-free description of a failure inside the `/api/auth/*`
 * handler.
 *
 * The handler proxies OAuth callbacks and token exchanges, so a thrown object
 * can carry an authorization code, an access or refresh token, a state value or
 * a full upstream response. Logging the raw error serializes all of that. This
 * reduces it to an operator-useful shape: the error class, a conservatively
 * validated stable code, and the request id needed to correlate.
 */

/** Stable machine codes only: screaming snake case, never a credential. */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface SafeAuthErrorEvent {
  event: "auth_handler_failed";
  requestId: string;
  method: string;
  errorClass: string;
  errorCode?: string;
}

export function safeAuthErrorEvent(
  error: unknown,
  requestId: string,
  method: string,
): SafeAuthErrorEvent {
  const errorClass = error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
  const rawCode = (error as { code?: unknown } | null | undefined)?.code;
  const errorCode = typeof rawCode === "string" && SAFE_CODE.test(rawCode) ? rawCode : undefined;
  return {
    event: "auth_handler_failed",
    requestId,
    method,
    errorClass,
    ...(errorCode ? { errorCode } : {}),
  };
}
