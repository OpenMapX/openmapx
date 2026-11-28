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

function describeAuthError(error: unknown): { errorClass: string; errorCode?: string } {
  const errorClass = error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
  // The auth library's APIError keeps its code in the response body.
  const candidate = error as { code?: unknown; body?: { code?: unknown } } | null | undefined;
  const rawCode = candidate?.code ?? candidate?.body?.code;
  const errorCode = typeof rawCode === "string" && SAFE_CODE.test(rawCode) ? rawCode : undefined;
  return { errorClass, ...(errorCode ? { errorCode } : {}) };
}

export function safeAuthErrorEvent(
  error: unknown,
  requestId: string,
  method: string,
): SafeAuthErrorEvent {
  return { event: "auth_handler_failed", requestId, method, ...describeAuthError(error) };
}

export interface SafeAuthEndpointErrorEvent {
  event: "auth_endpoint_failed";
  errorClass: string;
  errorCode?: string;
}

/**
 * The same bounded description for a failure better-auth caught inside one of
 * its endpoints and answered itself, where no request id is at hand.
 */
export function safeAuthEndpointErrorEvent(error: unknown): SafeAuthEndpointErrorEvent {
  return { event: "auth_endpoint_failed", ...describeAuthError(error) };
}
