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
 * (`:class`, `:id`, `:action`) and the `component` query, which are sanitized
 * before interpolation (see `index.ts`).
 */

import type { HttpClient, ResponseOptions } from "@openmapx/integration-framework";

/** OpenConditions' contributions-api listens on 4200 by default. */
const DEFAULT_CONTRIBUTIONS_URL = "http://localhost:4200";

/**
 * Ceiling for a contributions-api answer. Issuer keys and errors are tiny, but a
 * vote echoes the whole voted record, whose geometry can come from an official
 * feed rather than the browser's point report.
 */
const RELAY_MAX_BYTES = 256 * 1024;

/** Upstream response, passed through verbatim (status + parsed JSON body). */
export interface RelayResult {
  status: number;
  body: unknown;
}

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
  timeoutMs?: number;
}

/**
 * Forward one request to the contributions-api and return its status + JSON body
 * unchanged. `path` must be an absolute path beginning with `/contrib/…`.
 * A redirect, a non-JSON answer or an oversized body rejects, which the routes
 * report as an unavailable contributions service.
 */
export async function relayContribution(
  http: HttpClient,
  method: "GET" | "POST",
  path: string,
  opts: RelayOptions = {},
): Promise<RelayResult> {
  const url = `${opts.base ?? contributionsBaseUrl()}${path}`;
  const options: ResponseOptions = {
    headers: { Accept: "application/json" },
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxBytes: RELAY_MAX_BYTES,
    contentTypes: ["application/json"],
    redirect: "error",
  };
  const res =
    method === "GET"
      ? await http.getResponse(url, options)
      : await http.postResponse(url, opts.body, options);
  return { status: res.status, body: res.body };
}

/** Sub-claim actions the vote route forwards; anything else is rejected. */
export const SUBCLAIM_ACTIONS = ["confirm", "negate", "flag"] as const;
export type SubClaimAction = (typeof SUBCLAIM_ACTIONS)[number];

/** Narrow a caller-supplied `:action` param to the allowed set (SSRF guard). */
export function isSubClaimAction(value: string): value is SubClaimAction {
  return (SUBCLAIM_ACTIONS as readonly string[]).includes(value);
}

/** Record classes a vote can name; anything else is rejected. */
export const RECORD_CLASSES = ["feature", "situation", "observation", "offer"] as const;
export type RecordClass = (typeof RECORD_CLASSES)[number];

/** Narrow a caller-supplied `:class` param to the allowed set (SSRF guard). */
export function isRecordClass(value: string): value is RecordClass {
  return (RECORD_CLASSES as readonly string[]).includes(value);
}

/**
 * Reject a caller-supplied record id that could traverse the upstream path.
 * `encodeURIComponent` already neutralizes slashes, but `.`/`..` are left
 * verbatim and could still be interpreted as path segments upstream, so refuse
 * them (and any empty/whitespace or slash-bearing id) before building the URL.
 */
export function isSafeReportId(id: string): boolean {
  if (!id || id.trim() === "" || id === "." || id === "..") return false;
  return !/[/\\]/.test(id);
}
