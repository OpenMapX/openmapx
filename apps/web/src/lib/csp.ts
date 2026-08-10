/**
 * The production Content-Security-Policy.
 *
 * The goal is a `script-src` with no `unsafe-inline` and no `unsafe-eval`, so
 * that an injected `<script>`, an inline `onclick`, a `javascript:` URL, or an
 * `eval` of attacker-controlled text simply does not run. That is only
 * achievable with a per-request nonce, which is why this is built here rather
 * than written once into the static header config.
 *
 * Two directives are deliberately not tightened, and both are worth naming:
 *
 * `style-src` keeps `unsafe-inline`. MUI's emotion runtime and MapLibre both
 * write style elements at runtime, and nonce-ing every one of them is not
 * currently possible without replacing the styling engine. Inline *style* is a
 * far weaker capability than inline *script* — it cannot execute — so this is a
 * real but bounded exception rather than a hole.
 *
 * `connect-src` and `img-src` stay broad. Tiles, overlays, and self-hosted data
 * services live on origins an operator configures at runtime; the product does
 * not know them at build time and enumerating them would break self-hosting.
 * Crucially this does not widen anything the native bridge relies on: the shell
 * checks the exact document origin itself, and a permissive `connect-src` gives
 * a page no ability to talk to the shell.
 */

/** A fresh 128-bit nonce, base64. */
export function cspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export interface CspOptions {
  /** Development needs `unsafe-eval` for React Refresh; production must not. */
  development?: boolean;
  /**
   * Where community integration bundles are served from.
   *
   * These are self-hosted reviewed modules, not third-party scripts, and they
   * are only ever loaded by the browser/PWA — the installed shell removes them
   * before any of this matters.
   */
  apiOrigin?: string;
}

/** The API origin as a bare origin, or null when it is same-origin or unset. */
function scriptOrigin(apiOrigin: string | undefined): string | null {
  if (!apiOrigin) return null;
  try {
    return new URL(apiOrigin).origin;
  } catch {
    return null;
  }
}

export function buildCsp(nonce: string, options: CspOptions = {}): string {
  const extraScriptOrigin = scriptOrigin(options.apiOrigin);
  const scriptSrc = [
    "script-src 'self'",
    `'nonce-${nonce}'`,
    // Lets a nonced script load the chunks it needs without nonce-ing each one,
    // which is what makes this workable with a bundler at all.
    "'strict-dynamic'",
    ...(extraScriptOrigin ? [extraScriptOrigin] : []),
    // React Refresh compiles components at runtime. Never in production.
    ...(options.development ? ["'unsafe-eval'"] : []),
  ].join(" ");

  const imageSources = options.development ? " http:" : "";

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "frame-src 'none'",
    "form-action 'self'",
    scriptSrc,
    `img-src 'self' data: blob: https:${imageSources}`,
    "font-src 'self' data:",
    // See the module comment: inline style cannot execute.
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "connect-src 'self' https: http: ws: wss: data: blob:",
    "manifest-src 'self'",
  ].join("; ");
}
