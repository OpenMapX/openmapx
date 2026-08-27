import { readBoundedResponseText, USER_AGENT_CONTACT } from "@openmapx/core";
import { assertResolvesToPublicIp } from "@openmapx/core/server";
import type { Logger } from "@openmapx/integration-framework";

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 800_000;
const MAX_REDIRECTS = 5;

export interface BookingDates {
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  rooms?: number;
}

/**
 * Known booking-engine (IBE) hosts. A link to one already carries the property
 * id, so it's a precise official entry point — far better than the homepage.
 * For engines whose date params we're confident about we append the stay;
 * others are passed through (their own date picker takes over). Best-effort,
 * same philosophy as the OTA builders.
 */
const IBE_ENGINES: ReadonlyArray<{
  test: RegExp;
  withDates?: (u: URL, d: BookingDates) => void;
}> = [
  {
    // SynXis (Sabre): be.synxis.com/?hotel=<id>&arrive=&depart=&adult=&rooms=
    test: /(^|\.)synxis\.com$/i,
    withDates: (u, d) => {
      if (d.checkIn) u.searchParams.set("arrive", d.checkIn);
      if (d.checkOut) u.searchParams.set("depart", d.checkOut);
      if (d.adults) u.searchParams.set("adult", String(d.adults));
      if (d.rooms) u.searchParams.set("rooms", String(d.rooms));
    },
  },
  {
    // Cloudbeds: hotels.cloudbeds.com/reservation/<id>?checkin=&checkout=
    test: /(^|\.)cloudbeds\.com$/i,
    withDates: (u, d) => {
      if (d.checkIn) u.searchParams.set("checkin", d.checkIn);
      if (d.checkOut) u.searchParams.set("checkout", d.checkOut);
    },
  },
  // Property-specific entry points passed through (date param names vary; do not
  // invent them — issue caught in review). Still beats the marketing homepage.
  { test: /(^|\.)mews\.com$/i },
  { test: /(^|\.)thebookingbutton\.com$/i },
  { test: /(^|\.)profitroom\.com$/i },
  { test: /(^|\.)secure-hotel-booking\.com$/i }, // D-EDGE
  { test: /(^|\.)bookassist\.(com|org)$/i },
];

function asAbsoluteUrl(value: string, base: string): URL | null {
  try {
    const u = new URL(value, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Asset URLs that happen to point at an engine host (scripts/styles/images). */
const IBE_ASSET_RE = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)$/i;

/** Apply a known engine's dated params (if any) and return the string, or null. */
function buildIbeUrl(u: URL, dates: BookingDates): string | null {
  const engine = IBE_ENGINES.find((e) => e.test.test(u.hostname));
  if (!engine) return null;
  // A booking-engine link is only useful if it already carries a property
  // identifier — a path or a query. Reject a bare engine host (e.g. a
  // `<link rel="preconnect" href="https://be.synxis.com">` hint), which would
  // otherwise yield a property-less, wrongly-"dated" landing page, plus obvious
  // asset URLs (engines serve scripts/widgets from the same hosts).
  const hasIdentifier = (u.pathname && u.pathname !== "/") || u.search.length > 0;
  if (!hasIdentifier || IBE_ASSET_RE.test(u.pathname)) return null;
  engine.withDates?.(u, dates);
  return u.toString();
}

function fillTemplate(tmpl: string, dates: BookingDates): string {
  return tmpl
    .replace(/\{check_?in\}|\{checkin\}|\{arrival(?:_date)?\}/gi, dates.checkIn ?? "")
    .replace(/\{check_?out\}|\{checkout\}|\{departure(?:_date)?\}/gi, dates.checkOut ?? "");
}

/** Walk a parsed JSON-LD value for a ReserveAction target urlTemplate. */
function findReserveTarget(
  node: unknown,
  base: string,
  dates: BookingDates,
  depth = 0,
): string | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const it of node) {
      const u = findReserveTarget(it, base, dates, depth + 1);
      if (u) return u;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const action = (obj.potentialAction ?? obj) as Record<string, unknown>;
  const type = action["@type"];
  const isReserve =
    (typeof type === "string" && /ReserveAction/i.test(type)) ||
    (Array.isArray(type) && type.some((t) => typeof t === "string" && /ReserveAction/i.test(t)));
  if (isReserve) {
    const target = (action.target ?? action) as Record<string, unknown>;
    const tmpl = target.urlTemplate ?? target.url ?? action.url;
    if (typeof tmpl === "string") {
      const abs = asAbsoluteUrl(fillTemplate(tmpl, dates), base);
      if (abs) return abs.toString();
    }
  }
  for (const v of Object.values(obj)) {
    const u = findReserveTarget(v, base, dates, depth + 1);
    if (u) return u;
  }
  return null;
}

function extractReserveActionUrl(html: string, base: string, dates: BookingDates): string | null {
  // Scan <script type="application/ld+json"> blocks with indexOf rather than a
  // lazy-quantifier regex (`[\s\S]*?</script>`), which can backtrack badly on a
  // hostile/un-closed block — this parses untrusted third-party HTML server-side.
  let offset = 0;
  while (offset < html.length) {
    const open = html.indexOf("<script", offset);
    if (open === -1) break;
    const tagEnd = html.indexOf(">", open);
    if (tagEnd === -1) break;
    const openTag = html.slice(open, tagEnd).toLowerCase();
    offset = tagEnd + 1;
    if (!openTag.includes("application/ld+json")) continue;
    const close = html.indexOf("</script", tagEnd + 1);
    const body = close === -1 ? html.slice(tagEnd + 1) : html.slice(tagEnd + 1, close);
    offset = close === -1 ? html.length : close + 1;
    let data: unknown;
    try {
      data = JSON.parse(body.trim());
    } catch {
      continue;
    }
    const url = findReserveTarget(data, base, dates);
    if (url) return url;
  }
  return null;
}

/**
 * Find an official, ideally-dated booking deep link inside a hotel's page HTML.
 * Pure (no network) so it is unit-testable. (1) schema.org ReserveAction
 * urlTemplate, then (2) a known booking-engine host in any href/src. Returns
 * null when neither is present (caller falls back to the homepage).
 */
export function extractOfficialBookingUrl(
  html: string,
  baseUrl: string,
  dates: BookingDates,
): string | null {
  const fromSchema = extractReserveActionUrl(html, baseUrl, dates);
  if (fromSchema) return fromSchema;
  const urlRe = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = urlRe.exec(html)) !== null) {
    const u = asAbsoluteUrl(m[1], baseUrl);
    if (!u) continue;
    const built = buildIbeUrl(u, dates);
    if (built) return built;
  }
  return null;
}

/**
 * Fetch the hotel's homepage (SSRF-safe, per-hop public-IP check + byte cap —
 * mirrors integrations/restaurants/menu.ts fetchText) and extract an official
 * booking deep link. Returns null on any failure.
 */
export async function fetchOfficialBookingUrl(
  website: string,
  dates: BookingDates,
  log: Logger,
): Promise<string | null> {
  try {
    let current = website;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = new URL(current);
      if (target.protocol !== "http:" && target.protocol !== "https:") return null;
      await assertResolvesToPublicIp(target.hostname); // re-checked every hop
      const res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT_CONTACT, Accept: "text/html,application/xhtml+xml" },
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
      const html = await readBoundedResponseText(res, MAX_BYTES, {
        truncate: true,
        label: "hotel website",
      });
      return extractOfficialBookingUrl(html, current, dates);
    }
    return null;
  } catch (err) {
    log.debug?.(`[hotels] official lookup failed ${website}: ${(err as Error).message}`);
    return null;
  }
}
