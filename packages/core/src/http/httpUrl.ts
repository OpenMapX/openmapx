/**
 * Coerce a raw, possibly scheme-less string (e.g. an OSM `website` tag) into a
 * canonical absolute `http(s)` URL. Prepends `https://` when no scheme is
 * present, then validates the result is http/https. Returns null for empty or
 * unusable input.
 *
 * Shared by the client (`resolveOsmMenuUrl`) and the server-side `restaurants`
 * integration (`normalizeWebsite`) so the "add scheme + validate" rule lives in
 * one place. No host allow/deny logic here — SSRF protection is enforced
 * separately at fetch time (see `assertResolvesToPublicIp`).
 */
export function toHttpUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProto);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Reduce a URL to its bare display domain — host without a leading `www.` (e.g.
 * `https://www.ubereats.com/` → `ubereats.com`). Falls back to a regex strip
 * for inputs `URL` can't parse. Shared by the web UI and the food-delivery
 * integration's `/providers` response.
 */
export function bareDomain(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "");
  }
}
