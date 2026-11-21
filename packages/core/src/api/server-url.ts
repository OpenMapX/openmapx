/**
 * Base URL the web container uses for server-side fetches against the API.
 *
 * Server components shouldn't go through Traefik because the public domain
 * may be gated behind basic auth, IP allowlists, or just incur an extra TLS
 * round-trip the user paid for in cookies — the API container is always
 * reachable directly on the internal Docker network.
 *
 * Resolution order:
 *   1. `INTERNAL_API_URL` — set by the rendered compose to `http://openmapx-api:3001`,
 *      the API's project-unique alias on the internal network.
 *   2. `NEXT_PUBLIC_API_URL` — fallback for non-Docker / dev runs where
 *      both client and server share the same hostname.
 *   3. `http://localhost:3001` — final fallback for `pnpm dev`.
 *
 * Returned URL has no trailing slash.
 */
export function serverApiUrl(): string {
  const url =
    process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  return url.replace(/\/+$/, "");
}
