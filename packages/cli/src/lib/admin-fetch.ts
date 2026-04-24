/**
 * Thin wrapper over `fetch` that attaches the local admin token when the CLI
 * is calling a loopback API. The token is read from `OPENMAPX_LOCAL_ADMIN_TOKEN`
 * so CLI invocations inside a configured environment automatically authenticate.
 * Omitting the token preserves the legacy dev-loopback behaviour.
 */
export function adminFetch(input: string | URL, init: RequestInit = {}): ReturnType<typeof fetch> {
  const token = process.env.OPENMAPX_LOCAL_ADMIN_TOKEN?.trim();
  if (!token) return fetch(input, init);
  const headers = new Headers(init.headers);
  if (!headers.has("x-openmapx-local-admin")) {
    headers.set("x-openmapx-local-admin", token);
  }
  return fetch(input, { ...init, headers });
}
