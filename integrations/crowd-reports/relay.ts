/**
 * Server-side relay to the self-hosted OpenConditions contributions-api.
 *
 * The browser signs a crowd report with its device key and POSTs the envelope
 * to `/api/integrations/crowd-reports/*`; these routes forward it, unchanged, to
 * the contributions-api which does all verification. Mirrors the
 * `integrations/reviews-mangrove` browser-signs → apps/api relay → external
 * service pattern.
 *
 * The base URL is an operator-configured env var (never user-supplied), so this
 * is the same trust model as the `apps/api/src/routes/data-manager.ts` relay to
 * the internal data-manager service: a self-hosted service on the internal
 * network. The SSRF-relevant surface here is the caller-supplied path segments
 * (`:id`, `:action`), which are sanitized before interpolation (see `index.ts`).
 */

const DEFAULT_CONTRIBUTIONS_URL = "http://localhost:3002";

/** Upstream response, passed through verbatim (status + parsed JSON body). */
export interface RelayResult {
  status: number;
  body: unknown;
}

export type FetchImpl = typeof fetch;

/**
 * Resolve the contributions-api base URL from the environment, trimming a
 * trailing slash. Uses `||` (not `??`) so a Compose-injected empty string
 * (`${VAR:-}`) falls back to the default rather than becoming a broken base.
 */
export function contributionsBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPENCONDITIONS_CONTRIBUTIONS_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_CONTRIBUTIONS_URL).replace(/\/+$/, "");
}

export interface RelayOptions {
  body?: unknown;
  base?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/**
 * Forward one request to the contributions-api and return its status + JSON body
 * unchanged. `path` must be an absolute path beginning with `/contrib/…`.
 * Non-JSON upstream bodies are wrapped as `{ raw }` so a handler never throws on
 * an unexpected content type.
 */
export async function relayContribution(
  method: "GET" | "POST",
  path: string,
  opts: RelayOptions = {},
): Promise<RelayResult> {
  const base = opts.base ?? contributionsBaseUrl();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/** Sub-claim actions the vote route forwards; anything else is rejected. */
export const SUBCLAIM_ACTIONS = ["confirm", "negate", "flag"] as const;
export type SubClaimAction = (typeof SUBCLAIM_ACTIONS)[number];

/** Narrow a caller-supplied `:action` param to the allowed set (SSRF guard). */
export function isSubClaimAction(value: string): value is SubClaimAction {
  return (SUBCLAIM_ACTIONS as readonly string[]).includes(value);
}

/**
 * Reject a caller-supplied report id that could traverse the upstream path.
 * `encodeURIComponent` already neutralizes slashes, but `.`/`..` are left
 * verbatim and could still be interpreted as path segments upstream, so refuse
 * them (and any empty/whitespace or slash-bearing id) before building the URL.
 */
export function isSafeReportId(id: string): boolean {
  if (!id || id.trim() === "" || id === "." || id === "..") return false;
  return !/[/\\]/.test(id);
}
