/**
 * Thin wrapper over `fetch` that attaches the local admin token when the CLI
 * is calling a loopback API. The header is read from `OPENMAPX_LOCAL_ADMIN_TOKEN`
 * so CLI invocations inside a configured environment automatically authenticate.
 *
 * The header is sent unconditionally — even when no token is configured — so
 * the API can require its presence to defeat browser-form CSRF. (Custom
 * headers cannot be set on simple cross-origin POSTs without a CORS preflight,
 * which the admin routes do not grant.) When a token is configured, the
 * server-side comparison runs in constant time.
 */
const LOCAL_ADMIN_HEADER = "x-openmapx-local-admin";

export function adminFetch(input: string | URL, init: RequestInit = {}): ReturnType<typeof fetch> {
  const token = process.env.OPENMAPX_LOCAL_ADMIN_TOKEN?.trim() ?? "";
  const headers = new Headers(init.headers);
  if (!headers.has(LOCAL_ADMIN_HEADER)) {
    headers.set(LOCAL_ADMIN_HEADER, token);
  }
  return fetch(input, { ...init, headers });
}
