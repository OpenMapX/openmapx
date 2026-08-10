/**
 * The WebView half of the system-browser handoff.
 *
 * The app opened a browser, the browser signed somebody in, and the app came
 * back with an opaque code and the verifier it kept. This turns that pair into a
 * session — once, immediately, and with nothing written down.
 *
 * "Nothing written down" is the constraint that shapes the rest. There is no
 * retry, no queue, and no persistence of a partially-completed exchange. If the
 * page reloads mid-flight, or the exchange fails for any reason, the honest
 * outcome is that the user signs in again: a code that might or might not have
 * been consumed is not something to keep trying, and a stored one is a
 * credential-shaped thing sitting in browser storage.
 */

export type SystemAuthExchangeStatus = "ok" | "invalid" | "unavailable";

export interface SystemAuthHandoff {
  callbackCode: string;
  state: string;
  codeVerifier: string;
}

export interface ExchangeDeps {
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** Better Auth's own verify, which is what actually sets the session cookie. */
  verifyOneTimeToken: (token: string) => Promise<boolean>;
  /** Re-reads the session so the UI reflects it. */
  refreshSession: () => Promise<void> | void;
}

/** Everything the exchange accepts, bounded before it is sent. */
function wellFormed(handoff: SystemAuthHandoff): boolean {
  const base64url = /^[A-Za-z0-9_-]+$/;
  return (
    base64url.test(handoff.callbackCode) &&
    handoff.callbackCode.length >= 16 &&
    handoff.callbackCode.length <= 256 &&
    base64url.test(handoff.codeVerifier) &&
    handoff.codeVerifier.length >= 43 &&
    handoff.codeVerifier.length <= 128 &&
    base64url.test(handoff.state) &&
    handoff.state.length >= 16 &&
    handoff.state.length <= 128
  );
}

/**
 * Redeems the handoff and establishes the WebView session.
 *
 * The one-time token exists only inside this function. It is not returned, not
 * stored, and not logged — the caller learns whether it worked, which is all
 * the caller has any use for.
 */
export async function redeemSystemAuth(
  handoff: SystemAuthHandoff,
  deps: ExchangeDeps,
): Promise<SystemAuthExchangeStatus> {
  if (!wellFormed(handoff)) return "invalid";

  const doFetch = deps.fetch ?? globalThis.fetch;
  let token: string;
  try {
    const response = await doFetch(`${deps.apiBaseUrl.replace(/\/$/, "")}/mobile-auth/exchange`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        callbackCode: handoff.callbackCode,
        codeVerifier: handoff.codeVerifier,
        state: handoff.state,
      }),
    });
    if (!response.ok) return response.status >= 500 ? "unavailable" : "invalid";
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string" || body.token.length === 0) return "invalid";
    token = body.token;
  } catch {
    // The network failed, so the code may or may not have been consumed. That
    // ambiguity is exactly why there is no retry: a fresh sign-in is cheap and
    // unambiguous.
    return "unavailable";
  }

  try {
    const verified = await deps.verifyOneTimeToken(token);
    if (!verified) return "invalid";
  } catch {
    return "unavailable";
  } finally {
    // Not a security control on its own — the string was already copied by the
    // engine — but it keeps the value out of anything that snapshots locals.
    token = "";
  }

  await deps.refreshSession();
  return "ok";
}

/**
 * Reads an `auth.result` payload.
 *
 * A success is only a success if all three parts arrived: the code is useless
 * without the verifier, and the state is what proves the callback belonged to
 * the attempt this app started. A partial result is a failure, not something to
 * try redeeming with whatever is missing.
 */
export function readAuthResult(
  payload: unknown,
): (SystemAuthHandoff & { status: "ok" }) | { status: "cancelled" | "failed" } | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as {
    status?: unknown;
    handoffCode?: unknown;
    state?: unknown;
    codeVerifier?: unknown;
  };
  if (raw.status === "cancelled" || raw.status === "failed") return { status: raw.status };
  if (raw.status !== "ok") return null;
  if (
    typeof raw.handoffCode !== "string" ||
    typeof raw.state !== "string" ||
    typeof raw.codeVerifier !== "string"
  ) {
    return null;
  }
  return {
    status: "ok",
    callbackCode: raw.handoffCode,
    state: raw.state,
    codeVerifier: raw.codeVerifier,
  };
}
