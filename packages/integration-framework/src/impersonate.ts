import { Impit, type ImpitResponse } from "impit";

let client: Impit | undefined;

/**
 * A `fetch()` variant that presents a real browser's TLS/HTTP fingerprint via
 * `impit`. Some upstreams put their API behind Cloudflare bot-mitigation that
 * serves a *managed challenge* (HTTP 403, `cf-mitigated: challenge`, a
 * "Just a moment…" page) to Node's undici fingerprint while letting browsers
 * through — changing the User-Agent or headers does not help, because the block
 * is at the TLS-handshake layer. Impersonation clears it. OpenChargeMap
 * (`api.openchargemap.io`) is the current example.
 *
 * Shared by the API's health-check sweep (manifest `healthCheck[].impersonate`)
 * and by integration data-fetch code (e.g. the ev-charging OpenChargeMap
 * provider). Lives in a server-only framework subpath — like `./installer`, it
 * is never re-exported from the barrel, so the native `impit` module is never
 * pulled into the web bundle.
 *
 * One shared Impit instance is reused — it owns a connection pool, so
 * constructing one per call would be wasteful. `browser: "chrome"` emulates a
 * current Chrome ClientHello; `timeout` is a backstop so a request can never
 * hang indefinitely even if the caller's AbortSignal is not honoured.
 */
export function impersonatingFetch(
  resource: string | URL,
  init?: Parameters<Impit["fetch"]>[1],
): Promise<ImpitResponse> {
  client ??= new Impit({ browser: "chrome", timeout: 30_000 });
  return client.fetch(resource, init);
}
