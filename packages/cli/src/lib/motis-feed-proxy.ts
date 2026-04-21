import { existsSync, readFileSync } from "node:fs";

export interface TransitousFeedProxyEntry {
  url: string;
  headers?: Record<string, string>;
  gbfs?: boolean;
}

export type TransitousFeedProxyVars = Record<string, TransitousFeedProxyEntry>;

function escapeNginxQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}

function sortedEntries(vars: TransitousFeedProxyVars): Array<[string, TransitousFeedProxyEntry]> {
  return Object.entries(vars).sort(([a], [b]) => a.localeCompare(b));
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

function normalizeFeedProxyVars(raw: unknown): TransitousFeedProxyVars {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Feed-proxy vars must be a JSON object");
  }

  const normalized: TransitousFeedProxyVars = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const rawUrl = (value as { url?: unknown }).url;
    if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) continue;
    const rawHeaders = (value as { headers?: unknown }).headers;
    const headers: Record<string, string> = {};
    let hasInvalidHeader = false;
    if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
      for (const [hKey, hValue] of Object.entries(rawHeaders as Record<string, unknown>)) {
        const headerName = hKey.trim();
        if (headerName.length === 0 || typeof hValue !== "string") {
          hasInvalidHeader = true;
          continue;
        }
        const trimmedValue = hValue.trim();
        if (trimmedValue.length === 0) {
          hasInvalidHeader = true;
          continue;
        }
        headers[hKey] = trimmedValue;
      }
    }
    if (hasInvalidHeader) continue;

    normalized[key] = {
      url: rawUrl.trim(),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      gbfs: (value as { gbfs?: unknown }).gbfs === true,
    };
  }

  return normalized;
}

export function readFeedProxyVars(jsonPath: string): TransitousFeedProxyVars {
  if (!existsSync(jsonPath)) return {};
  const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as unknown;
  return normalizeFeedProxyVars(parsed);
}

function renderPrimaryServer(entries: Array<[string, TransitousFeedProxyEntry]>): string[] {
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
    const parsedUrl = requireHttpUrl(entry.url);
    out.push(`  location "/feed/${encodeURIComponent(key)}" {`);
    out.push(`    set $feed_upstream "${escapeNginxQuoted(entry.url)}";`);
    out.push(`    set $original_host "${escapeNginxQuoted(parsedUrl.hostname)}";`);
    out.push("    proxy_pass $feed_upstream;");
    for (const header of renderHeaderDirectives(entry.headers)) {
      out.push(header);
    }
    out.push("  }");
    out.push("");
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

function renderGbfsServer(entry: TransitousFeedProxyEntry): string[] {
  const parsedUrl = requireHttpUrl(entry.url);
  const upstream = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const out = [
    "server {",
    "  listen 80;",
    `  server_name "${escapeNginxQuoted(parsedUrl.hostname)}";`,
    "",
    "  proxy_ssl_server_name on;",
    "  proxy_pass_header Server;",
    '  proxy_set_header User-Agent "openmapx/transitous-feed-proxy";',
    "  add_header X-Cache $upstream_cache_status;",
    "  add_header Link '<https://transitous.org/sources/>; rel=\"license\"';",
    "",
    "  proxy_cache feed-proxy;",
    "  proxy_buffering on;",
    "  proxy_ignore_headers Set-Cookie;",
    "  proxy_ignore_headers X-Accel-Expires;",
    "  proxy_ignore_headers Expires;",
    "  proxy_ignore_headers Cache-Control;",
    "  proxy_http_version 1.1;",
    "  proxy_cache_valid 200 80s;",
    "  proxy_cache_valid 400 401 403 404 200s;",
    "  proxy_ignore_client_abort on;",
    "  proxy_cache_use_stale error timeout invalid_header updating http_500 http_502 http_503 http_504 http_429;",
    "",
    "  limit_req zone=feed-proxy-quota burst=10000 nodelay;",
    "",
    "  location / {",
    `    set $feed_upstream "${escapeNginxQuoted(upstream)}";`,
    "    proxy_pass $feed_upstream;",
  ];
  for (const header of renderHeaderDirectives(entry.headers)) {
    out.push(header);
  }
  out.push("  }", "}");
  return out;
}

export function renderFeedProxyNginxConfig(vars: TransitousFeedProxyVars): string {
  const entries = sortedEntries(vars);
  const gbfsEntries = entries.filter(([, entry]) => entry.gbfs);

  const lines = [
    "# Generated by OpenMapX from Transitous feed-proxy vars",
    "proxy_cache_path /var/cache/nginx/feed-proxy max_size=10g keys_zone=feed-proxy:10m inactive=1h;",
    "limit_req_zone $binary_remote_addr zone=feed-proxy-quota:10m rate=10000r/m;",
    "limit_req_status 429;",
    "",
    ...renderPrimaryServer(entries),
  ];

  for (const [, entry] of gbfsEntries) {
    lines.push("", ...renderGbfsServer(entry));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
