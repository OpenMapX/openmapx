/**
 * Applying a link the shell handed to an already-running page.
 *
 * The intent has been through the shell's parser, which refuses anything that
 * could name a host, a port, a path or a fragment. What arrives here is either a
 * query string the web app already knows how to read, or a request to show the
 * running trip.
 *
 * It is validated again anyway. Not because the shell is untrusted, but because
 * this function is reachable from a bridge message and "the other side already
 * checked" is the assumption that turns one bug into two.
 */

export type NativeDeepLinkIntent = { kind: "map"; query: string } | { kind: "active-navigation" };

/** Matches the shell's own bound, so neither side can be the loose one. */
const MAX_QUERY_LENGTH = 2_048;

/**
 * Reads a `deep-link.open` payload, or refuses it.
 *
 * A query that carries a fragment, a scheme, or a leading `//` is refused rather
 * than sanitised: sanitising means guessing what was meant, and nothing here has
 * to guess.
 */
export function readNativeDeepLink(payload: unknown): NativeDeepLinkIntent | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as { kind?: unknown; query?: unknown };

  if (raw.kind === "active-navigation") return { kind: "active-navigation" };
  if (raw.kind !== "map") return null;

  const query = raw.query;
  if (typeof query !== "string") return null;
  if (query.length > MAX_QUERY_LENGTH) return null;
  if (query === "") return { kind: "map", query: "" };
  if (!query.startsWith("?")) return null;
  // `#` would smuggle a fragment past a check that only looked at the query;
  // `:` and `//` are how a query becomes a URL.
  if (query.includes("#") || query.includes("//")) return null;

  return { kind: "map", query };
}

export interface ApplyNativeDeepLinkDeps {
  /** Rewrites the address bar without a navigation. */
  replaceSearch: (query: string) => void;
  /** Tells the existing deep-link machinery to re-read the location. */
  notify: () => void;
  /** Brings the running navigation session to the front. */
  showActiveNavigation: () => void;
  /** Asks native for the whole session, since the page may be behind. */
  requestSnapshot: () => void;
}

/**
 * Applies the intent using the machinery the browser already uses.
 *
 * Deliberately goes through the location and the existing update event rather
 * than calling deep-link appliers directly: the browser path is the one that is
 * exercised constantly, and having the native path reuse it means there is one
 * behaviour to get right rather than two that drift.
 */
export function applyNativeDeepLink(
  intent: NativeDeepLinkIntent,
  deps: ApplyNativeDeepLinkDeps,
): void {
  if (intent.kind === "active-navigation") {
    // The page may have been reloaded while the trip kept running natively, so
    // ask what is true before showing anything.
    deps.requestSnapshot();
    deps.showActiveNavigation();
    return;
  }
  deps.replaceSearch(intent.query);
  deps.notify();
}
