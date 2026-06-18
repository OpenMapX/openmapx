import { assertResolvesToPublicIp, toHttpUrl } from "@openmapx/core/server";
import type { Logger } from "@openmapx/integration-framework";

const MAX_REDIRECTS = 5;

/** How a menu URL was discovered. */
export type MenuSource = "jsonld" | "heuristic" | "pdf";

export interface MenuResult {
  menuUrl: string;
  source: MenuSource;
  format: "html" | "pdf";
}

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 800_000;
const USER_AGENT = "OpenMapXBot/1.0 (+https://github.com/openmapx; restaurant menu-link finder)";

/**
 * Menu-link keywords across the languages OpenMapX is most likely to encounter.
 * Matched against anchor text as whole words (see `containsWord`).
 */
const MENU_TEXT_KEYWORDS = [
  "menu",
  "menus",
  "menü",
  "menu card",
  "speisekarte",
  "speisen",
  "getränkekarte",
  "karte",
  "carte",
  "la carte",
  "carta",
  "menù",
  "menukaart",
  "kaart",
  "jadłospis",
  "jadlospis",
  "meny",
  "ruokalista",
  "jelovnik",
  "jídelní lístek",
  "jidelni listek",
  "ementa",
  "matseðill",
  "our food",
  "our menu",
  "food menu",
  "view menu",
  "see menu",
  "drinks",
];

/** Path tokens that strongly indicate a menu page. */
const MENU_PATH_TOKENS = [
  "menu",
  "menus",
  "speisekarte",
  "speisen",
  "getraenkekarte",
  "getrankekarte",
  "karte",
  "carte",
  "carta",
  "our-food",
  "our-menu",
  "food",
  "jadlospis",
  "ementa",
];

/** Common named HTML entities that appear inside menu-link anchor text. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  yacute: "ý",
};

/** `String.fromCodePoint` for valid Unicode scalars only; null otherwise. */
function safeCodePoint(n: number): string | null {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

/** Decode numeric (`&#252;`, `&#xfc;`) and the common named HTML entities. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => safeCodePoint(Number.parseInt(hex, 16)) ?? m)
    .replace(/&#(\d+);/g, (m, dec) => safeCodePoint(Number.parseInt(dec, 10)) ?? m)
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/&[a-z]+;/gi, " ") // drop any leftover unknown entities
    .replace(/\s+/g, " ")
    .trim();
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * True when `token` appears in `haystack` as a whole word/phrase — bounded by a
 * non-alphanumeric character or a string edge on both sides. Prevents short
 * tokens ("food", "karte") from substring-matching inside larger words
 * ("seafood", "Eintrittskarten").
 */
function containsWord(haystack: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(token, from);
    if (idx === -1) return false;
    const before = haystack[idx - 1];
    const after = haystack[idx + token.length];
    if (
      (before === undefined || !WORD_CHAR.test(before)) &&
      (after === undefined || !WORD_CHAR.test(after))
    ) {
      return true;
    }
    from = idx + 1;
  }
}

/**
 * Normalise to a fetchable absolute http(s) URL (adds `https://` when the OSM
 * `website` tag omits a scheme). Returns null for unusable / non-http input.
 *
 * No host allow/deny logic lives here: SSRF protection is enforced at fetch time
 * by `assertResolvesToPublicIp` (DNS-resolved private-IP denylist, re-checked on
 * every redirect hop) — the canonical helper from `@openmapx/core/server`,
 * which is stronger than a literal-host check and avoids duplicating the list.
 */
export function normalizeWebsite(input: string): string | null {
  return toHttpUrl(input);
}

function isPdf(path: string): boolean {
  return path.toLowerCase().split("?")[0].endsWith(".pdf");
}

// Hand-rolled redirect loop rather than the shared `fetchWithRedirects`: that
// helper only takes a synchronous `validateRedirectUrl`, so it can't run the
// `await assertResolvesToPublicIp` per-hop DNS check below, and `safeDownload`
// streams to disk. This loop is the in-memory, byte-capped, per-hop-SSRF-checked
// variant; it still reuses the canonical SSRF primitive.
async function fetchText(url: string, log: Logger): Promise<string | null> {
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = new URL(current);
      if (target.protocol !== "http:" && target.protocol !== "https:") return null;
      // SSRF guard (reused from @openmapx/core/server): DNS-resolve the host and
      // reject private/reserved targets. Re-checked on every redirect hop so a
      // public URL cannot bounce us onto an internal address.
      await assertResolvesToPublicIp(target.hostname);
      const res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (!location) return null;
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) return null;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("html") && !ct.includes("text")) return null;
      const buf = await res.arrayBuffer();
      const truncated = buf.byteLength > MAX_BYTES;
      const bytes = truncated ? buf.slice(0, MAX_BYTES) : buf;
      // `stream: true` on a truncated slice makes the decoder hold back (drop) an
      // incomplete trailing multi-byte sequence instead of emitting U+FFFD, so
      // the byte cut never corrupts the last character we keep.
      return new TextDecoder("utf-8").decode(bytes, { stream: truncated });
    }
    return null;
  } catch (err) {
    log.debug?.(`[restaurants] fetch failed ${url}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Minimal, good-faith robots.txt check: bail only when the global `User-agent: *`
 * group disallows the site root (`Disallow: /`). We never crawl beyond the
 * homepage, so this is the only directive that should stop us.
 */
async function rootCrawlAllowed(origin: string, log: Logger): Promise<boolean> {
  const txt = await fetchText(`${origin}/robots.txt`, log);
  if (!txt) return true; // no robots.txt ⇒ allowed
  const lines = txt.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  let groupHasStar = false;
  let sawRuleInGroup = false;
  let starDisallowAll = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      // Consecutive User-agent lines share one group (RFC 9309); a User-agent
      // line that follows a rule starts a NEW group, so only reset there —
      // otherwise `User-agent: *` followed by another agent then `Disallow: /`
      // would lose the `*` disallow.
      if (sawRuleInGroup) {
        groupHasStar = false;
        sawRuleInGroup = false;
      }
      if (value === "*") groupHasStar = true;
    } else if (key === "disallow" || key === "allow") {
      sawRuleInGroup = true;
      if (key === "disallow" && groupHasStar && value === "/") starDisallowAll = true;
    }
  }
  return !starDisallowAll;
}

interface JsonLdNode {
  "@type"?: string | string[];
  hasMenu?: unknown;
  menu?: unknown;
  "@graph"?: unknown;
  [k: string]: unknown;
}

function asUrl(value: unknown, base: string): string | null {
  if (typeof value === "string") {
    try {
      const u = new URL(value, base);
      return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === "string") return asUrl(obj.url, base);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const u = asUrl(item, base);
      if (u) return u;
    }
  }
  return null;
}

/**
 * Recursively collect every object node in a parsed JSON-LD value, so a
 * Restaurant nested under a property (e.g. `mainEntity`) — not just top-level
 * entries or `@graph` members — is inspected for `hasMenu`/`menu`. Depth-capped
 * to avoid pathological documents.
 */
function collectJsonLdNodes(value: unknown, out: JsonLdNode[], depth = 0): void {
  if (depth > 6 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdNodes(item, out, depth + 1);
    return;
  }
  out.push(value as JsonLdNode);
  for (const v of Object.values(value)) {
    if (v && typeof v === "object") collectJsonLdNodes(v, out, depth + 1);
  }
}

/** Resolve a menu URL from embedded schema.org JSON-LD (`hasMenu` / `menu`). */
function fromJsonLd(html: string, base: string): MenuResult | null {
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const nodes: JsonLdNode[] = [];
  for (const m of html.matchAll(scriptRe)) {
    const body = m[1]?.trim();
    if (!body) continue;
    try {
      collectJsonLdNodes(JSON.parse(body), nodes);
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  for (const node of nodes) {
    const menuValue = node.hasMenu ?? node.menu;
    if (menuValue === undefined) continue;
    const url = asUrl(menuValue, base);
    if (url) {
      return {
        menuUrl: url,
        source: "jsonld",
        format: isPdf(new URL(url).pathname) ? "pdf" : "html",
      };
    }
  }
  return null;
}

/** Resolve a menu URL by scoring the page's anchor links. */
function fromHeuristics(html: string, base: string): MenuResult | null {
  const baseHost = (() => {
    try {
      return new URL(base).host;
    } catch {
      return "";
    }
  })();
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let best: { url: string; score: number; pdf: boolean } | null = null;

  for (const m of html.matchAll(anchorRe)) {
    const href = m[1]?.trim();
    // Skip non-navigational hrefs, but keep non-empty same-page fragments
    // (`#menu`, `#speisekarte`, …) — restaurants often link the menu section in
    // the nav bar via a fragment rather than a separate page.
    if (!href || href === "#" || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;

    const path = url.pathname.toLowerCase();
    // Include the fragment so a same-page `#menu` anchor counts as a path match.
    const pathOrHash = `${path}${url.hash.toLowerCase()}`;
    const text = stripTags(m[2] ?? "").toLowerCase();
    const pdf = isPdf(path);
    // Whole-word (not substring) matching so short tokens like "food"/"karte"
    // don't match "/seafood" or "Eintrittskarten".
    const pathMatch = MENU_PATH_TOKENS.some((tok) => containsWord(pathOrHash, tok));
    const textMatch = MENU_TEXT_KEYWORDS.some((kw) => containsWord(text, kw));
    if (!pathMatch && !textMatch) continue;

    let score = 0;
    if (pathMatch) score += 3;
    if (textMatch) score += 2;
    if (pdf) score += 2;
    if (url.host === baseHost) score += 1;

    if (!best || score > best.score) best = { url: url.toString(), score, pdf };
  }

  if (best && best.score >= 3) {
    return {
      menuUrl: best.url,
      source: best.pdf ? "pdf" : "heuristic",
      format: best.pdf ? "pdf" : "html",
    };
  }
  return null;
}

/**
 * Resolve a restaurant's menu URL from its own website. Fetches the homepage
 * (robots.txt permitting), reads schema.org `hasMenu` first, then falls back to
 * scoring menu-like anchor links. We only ever return a LINK — never rehosted
 * menu content.
 */
export async function resolveMenuUrl(websiteUrl: string, log: Logger): Promise<MenuResult | null> {
  const normalized = normalizeWebsite(websiteUrl);
  if (!normalized) return null;
  const origin = new URL(normalized).origin;

  if (!(await rootCrawlAllowed(origin, log))) {
    log.debug?.(`[restaurants] robots.txt disallows crawl of ${origin}`);
    return null;
  }

  const html = await fetchText(normalized, log);
  if (!html) return null;

  return fromJsonLd(html, normalized) ?? fromHeuristics(html, normalized);
}
