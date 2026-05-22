import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Pure-data render of the Transitous-style feed-proxy nginx config.
 *
 * The data-manager pipeline calls {@link buildFeedProxyConfig} after running
 * `generate-motis-config.py --feed-proxy`; that script emits a JSON map of
 * feeds (URL + optional headers + optional `gbfs` flag) which gets rendered
 * into an nginx server block that proxies, caches, and rewrites the upstream
 * feeds for the MOTIS container to read.
 *
 * The operator-facing CLI (`packages/cli/src/lib/motis-feed-proxy.ts`) keeps
 * its own copy of the renderer; the two paths share intent but currently
 * differ slightly (the CLI also emits per-GBFS server blocks). They can
 * converge in a future cleanup; for now the data-manager pipeline only needs
 * the primary-server render produced here.
 */

export interface FeedProxyEntry {
  url: string;
  headers?: Record<string, string>;
  gbfs?: boolean;
}

export type FeedProxyVars = Record<string, FeedProxyEntry>;

export interface FeedProxyBuildInput {
  /** Parsed contents of `feed-proxy-vars.json`. */
  varsJson: unknown;
  /** Absolute path where the rendered `.conf` should be written. */
  outputPath: string;
}

export interface FeedProxyBuildResult {
  /** Whether the file was actually written. Always true on success — kept as a
   * field so future callers can short-circuit on no-op writes. */
  wrote: boolean;
  /** Number of feed entries rendered into the nginx config. */
  entries: number;
}

function escapeNginxQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}

function renderHeaderDirectives(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) =>
        `      proxy_set_header "${escapeNginxQuoted(key)}" "${escapeNginxQuoted(value)}";`,
    );
}

function requireHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`Invalid feed-proxy source URL "${url}": ${(error as Error).message}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported feed-proxy URL protocol for "${url}" (expected http/https)`);
  }
  return parsed;
}

function normalizeFeedProxyVars(raw: unknown): FeedProxyVars {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: FeedProxyVars = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const url = (value as { url?: unknown }).url;
    if (typeof url !== "string" || url.trim() === "") continue;
    const headersRaw = (value as { headers?: unknown }).headers;
    const headers: Record<string, string> = {};
    if (headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw)) {
      for (const [hk, hv] of Object.entries(headersRaw as Record<string, unknown>)) {
        if (typeof hv === "string" && hv.trim() !== "") headers[hk] = hv.trim();
      }
    }
    out[key] = {
      url: url.trim(),
      ...(Object.keys(headers).length ? { headers } : {}),
      gbfs: (value as { gbfs?: unknown }).gbfs === true,
    };
  }
  return out;
}

function renderPrimaryServer(entries: Array<[string, FeedProxyEntry]>): string[] {
  const out: string[] = [
    "server {",
    "  listen 80;",
    "  server_name _;",
    "",
    "  proxy_ssl_server_name on;",
    "  proxy_pass_header Server;",
    '  proxy_set_header User-Agent "openmapx/transitous-feed-proxy";',
    "  add_header X-Cache $upstream_cache_status;",
    "  add_header Link '<https://transitous.org/sources/>; rel=\"license\"';",
    "",
    "  proxy_cache feed-proxy;",
    '  proxy_cache_key "$request_uri";',
    "  proxy_buffering on;",
    "  proxy_ignore_headers Set-Cookie;",
    "  proxy_ignore_headers X-Accel-Expires;",
    "  proxy_ignore_headers Expires;",
    "  proxy_ignore_headers Cache-Control;",
    "  proxy_http_version 1.1;",
    "  proxy_intercept_errors on;",
    "  error_page 301 302 307 308 = @handle_redirects;",
    "  proxy_cache_valid 200 40s;",
    "  proxy_cache_valid 400 401 403 404 200s;",
    "  proxy_ignore_client_abort on;",
    "  proxy_cache_use_stale error timeout invalid_header updating http_500 http_502 http_503 http_504 http_429;",
    "",
    "  limit_req zone=feed-proxy-quota burst=10000 nodelay;",
    "",
    "  location = /healthz {",
    "    add_header Content-Type text/plain;",
    "    return 200 'ok';",
    "  }",
    "",
  ];

  for (const [key, entry] of entries) {
    const parsed = requireHttpUrl(entry.url);
    out.push(`  location "/feed/${encodeURIComponent(key)}" {`);
    out.push(`    set $feed_upstream "${escapeNginxQuoted(entry.url)}";`);
    out.push(`    set $original_host "${escapeNginxQuoted(parsed.hostname)}";`);
    out.push("    proxy_pass $feed_upstream;");
    for (const header of renderHeaderDirectives(entry.headers)) out.push(header);
    out.push("  }", "");
  }

  out.push(
    "  location @handle_redirects {",
    '    set $original_uri "$request_uri";',
    '    set $orig_loc "$upstream_http_location";',
    "",
    "    proxy_cache feed-proxy;",
    '    proxy_cache_key "$original_uri";',
    "    proxy_cache_valid 200 40s;",
    "    proxy_cache_valid 400 401 403 404 200s;",
    "",
    '    if ($orig_loc ~* "://") {',
    "      proxy_pass $orig_loc;",
    "      break;",
    "    }",
    "",
    '    if ($orig_loc !~* "://") {',
    "      proxy_pass $scheme://$original_host$orig_loc;",
    "      break;",
    "    }",
    "  }",
    "}",
  );

  return out;
}

export function renderFeedProxyNginxConfig(vars: FeedProxyVars): string {
  const entries = Object.entries(vars).sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    "# Generated by OpenMapX data-manager from Transitous feed-proxy vars",
    "proxy_cache_path /var/cache/nginx/feed-proxy max_size=10g keys_zone=feed-proxy:10m inactive=1h;",
    "limit_req_zone $binary_remote_addr zone=feed-proxy-quota:10m rate=10000r/m;",
    "limit_req_status 429;",
    "",
    ...renderPrimaryServer(entries),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a feed-proxy nginx config from a parsed JSON vars object and write
 * the result to disk. Pure helper — does NOT signal nginx to reload (that's
 * pipeline orchestration handled by the caller).
 *
 * Throws if any entry's `url` fails the http/https-only protocol check; this
 * surfaces malformed upstream catalogs (e.g. an `ftp://` feed) loudly instead
 * of silently dropping the entry.
 */
export async function buildFeedProxyConfig(
  input: FeedProxyBuildInput,
): Promise<FeedProxyBuildResult> {
  const vars = normalizeFeedProxyVars(input.varsJson);
  const rendered = renderFeedProxyNginxConfig(vars);
  mkdirSync(dirname(input.outputPath), { recursive: true });
  writeFileSync(input.outputPath, rendered, "utf-8");
  return { wrote: true, entries: Object.keys(vars).length };
}
