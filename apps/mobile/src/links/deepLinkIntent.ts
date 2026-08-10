/**
 * Turning an inbound link into something the app is willing to do.
 *
 * A deep link arrives from outside the app: another app, a browser, a
 * notification, a QR code. It is therefore treated as hostile input with one
 * narrow job — naming a place on the map the user already has, or asking to see
 * the trip already running.
 *
 * The single rule that everything else follows from: **a link can never select a
 * server.** Not by host, not by port, not by percent-encoding, not by a userinfo
 * segment that makes one host look like another. The origin is compiled in; a
 * link that disagrees with it is discarded rather than corrected, because a link
 * that could point the app at a different backend is a link that could point it
 * at somebody else's.
 */

export type DeepLinkIntent =
  /** Show the map, with a query the web app already knows how to read. */
  | { kind: "map"; query: string }
  /** Show the navigation session that is already running. */
  | { kind: "active-navigation" };

export interface DeepLinkConfig {
  /** The compiled web origin, e.g. `https://openmapx.com`. */
  webOrigin: string;
  /** The compiled custom scheme, without `:`, e.g. `openmapx`. */
  scheme: string;
}

/** Anything longer is not a map link; it is somebody trying something. */
export const MAX_LINK_LENGTH = 8 * 1024;
/** The query the web app is handed, after everything else has been stripped. */
const MAX_QUERY_LENGTH = 2_048;

/** Paths the shell refuses to treat as a map link. */
const REFUSED_PATH_PREFIXES = ["/api", "/mobile-auth", "/_next"];

/** The one internal path, which names a screen rather than a place. */
const ACTIVE_NAVIGATION_PATH = "/navigation/active";

/**
 * Parses a link, or refuses it.
 *
 * Returns null for everything it does not positively recognise. There is no
 * "best effort" branch on purpose: a link the shell half-understood is a link it
 * did not understand.
 */
export function parseDeepLinkIntent(
  rawLink: string,
  config: DeepLinkConfig,
): DeepLinkIntent | null {
  if (typeof rawLink !== "string" || rawLink.length === 0) return null;
  if (rawLink.length > MAX_LINK_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(rawLink);
  } catch {
    return null;
  }

  // Userinfo is the classic way to make one host look like another in a string
  // a human skims. Nothing legitimate here ever carries it.
  if (url.username !== "" || url.password !== "") return null;

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();

  if (scheme === config.scheme.toLowerCase()) return parseSchemeLink(url);
  if (scheme === "https") return parseHttpsLink(url, config);
  return null;
}

/**
 * `openmapx://…` — the app's own scheme.
 *
 * Any app on the device can send one of these, so the accepted vocabulary is
 * exactly two shapes and the host is not allowed to name anything.
 */
function parseSchemeLink(url: URL): DeepLinkIntent | null {
  // `openmapx://navigation/active` puts "navigation" in the host and "/active"
  // in the path; `openmapx:///navigation/active` puts it all in the path. Both
  // spellings occur in the wild, so they are normalised to one string.
  const path = normalisePath(`${url.host}${url.pathname}`);
  if (path === ACTIVE_NAVIGATION_PATH) return { kind: "active-navigation" };
  if (path === "" || path === "/") return mapIntent(url.search);
  return null;
}

/**
 * `https://openmapx.com/…` — a verified App Link or Universal Link.
 *
 * The OS has already checked the association, but this checks the origin again:
 * the same parser also runs on links that arrived through other routes, and an
 * origin check that only happens sometimes is not an origin check.
 */
function parseHttpsLink(url: URL, config: DeepLinkConfig): DeepLinkIntent | null {
  let compiled: URL;
  try {
    compiled = new URL(config.webOrigin);
  } catch {
    return null;
  }
  // Compared as a whole origin, so a matching host on a different port — or a
  // host that only matches after some encoding is undone — is not a match.
  if (url.origin !== compiled.origin) return null;

  const path = normalisePath(url.pathname);
  if (REFUSED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return null;
  }
  if (path === ACTIVE_NAVIGATION_PATH) return { kind: "active-navigation" };
  if (path === "" || path === "/") return mapIntent(url.search);
  // An unknown path on the right origin is still an unknown path. Loading it
  // would hand the WebView a screen nobody reviewed.
  return null;
}

/**
 * Keeps the query and nothing else.
 *
 * The fragment is dropped outright: it never reaches a server, it is the part of
 * a URL most likely to have been appended by whoever passed the link along, and
 * the web app has no fragment-driven behaviour that a link needs to reach.
 */
function mapIntent(search: string): DeepLinkIntent | null {
  const query = search.startsWith("?") ? search : search ? `?${search}` : "";
  if (query.length > MAX_QUERY_LENGTH) return null;
  return { kind: "map", query };
}

function normalisePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * The URL the WebView is actually pointed at for a cold start.
 *
 * Built from the compiled origin plus the validated query, never from the
 * inbound link's own string — so even a link that parsed cannot contribute a
 * host, a port, a path, or a fragment.
 */
export function coldStartUrl(intent: DeepLinkIntent, config: DeepLinkConfig): string {
  const base = new URL(config.webOrigin);
  base.pathname = "/";
  base.search = intent.kind === "map" ? intent.query : "";
  base.hash = "";
  return base.toString();
}
