/**
 * The navigation policy for the product WebView.
 *
 * The WebView renders exactly one origin, fixed at build time. Everything else
 * either goes to the operating system or is refused. The decision is made
 * structurally — parse the URL, compare scheme/host/port — never by prefix or
 * substring matching, which is what makes `openmapx.com.evil.example` and
 * `https://user:pass@openmapx.com/` look trustworthy to a naive check.
 */

export type NavigationDecision = "allow-in-webview" | "open-system" | "reject";

export interface NavigationPolicyConfig {
  /** The compiled product origin, e.g. `https://openmapx.com`. */
  webOrigin: string;
}

/**
 * A URL longer than this is refused before parsing. Real navigation targets are
 * far shorter, and an oversized string is either an attack or a bug.
 */
export const MAX_NAVIGATION_URL_LENGTH = 8 * 1024;

/** Schemes handed to the OS because the user plausibly asked for them. */
const SYSTEM_SCHEMES = new Set(["https:", "http:", "mailto:", "tel:"]);

/**
 * Only these schemes are eligible to render in the product WebView. The check
 * cannot be left to `origin` alone: per the URL specification a `blob:` URL
 * reports its *inner* origin, so `blob:https://openmapx.com/…` compares equal
 * to the product origin while actually being opaque local content.
 */
const NAVIGABLE_SCHEMES = new Set(["https:", "http:"]);

export function classifyNavigation(
  rawUrl: string,
  config: NavigationPolicyConfig,
): NavigationDecision {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return "reject";
  if (rawUrl.length > MAX_NAVIGATION_URL_LENGTH) return "reject";

  let candidate: URL;
  let product: URL;
  try {
    candidate = new URL(rawUrl);
    product = new URL(config.webOrigin);
  } catch {
    return "reject";
  }

  // Credentials in the authority survive `URL` parsing but are stripped from
  // `origin`, so an origin-only comparison would accept
  // `https://user:pass@openmapx.com/`. Refuse them outright.
  if (candidate.username || candidate.password) return "reject";

  if (!NAVIGABLE_SCHEMES.has(candidate.protocol)) {
    return SYSTEM_SCHEMES.has(candidate.protocol) ? "open-system" : "reject";
  }

  if (candidate.origin === product.origin) return "allow-in-webview";

  // Same host but a different scheme or port is never a link a user meaningfully
  // followed. Handing it to the system browser would only hide the downgrade.
  if (candidate.hostname === product.hostname) return "reject";

  return SYSTEM_SCHEMES.has(candidate.protocol) ? "open-system" : "reject";
}
