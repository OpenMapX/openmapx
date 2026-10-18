const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// The URL parser reads a host whose last label is a decimal or 0x-hex number
// as an IPv4 address (`127.1`, `cam.0x7f`), and no public suffix is numeric.
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~%-]+$/;
// An encoded dot, slash or backslash can be decoded by the upstream into a
// segment that climbs out of the prefix.
const ENCODED_SEPARATOR = /%(?:2e|2f|5c)/i;

// Domains under which anyone can rent a subdomain or a path (cloud storage,
// CDNs, app hosting). A wildcard over one of them, or one of their hosts
// without a path, would admit images any of their customers serve, so only
// an exact host with a path prefix (an S3 regional endpoint's bucket) may
// name them. OpenConditions keeps the same list and rules for a camera
// feed's `imageHosts` in `packages/cameras/src/feed-schema.ts`; the two
// repositories share no code, so a change here is copied there.
const MULTI_TENANT_DOMAINS = [
  "amazonaws.com",
  "cloudfront.net",
  "googleusercontent.com",
  "storage.googleapis.com",
  "blob.core.windows.net",
  "azurewebsites.net",
  "appspot.com",
  "herokuapp.com",
  "github.io",
  "r2.dev",
  "workers.dev",
  "pages.dev",
  "netlify.app",
  "vercel.app",
];
// Second-level public suffixes under a country code (`co.uk`, `com.au`,
// `gov.tw`): a wildcard over one spans unrelated registrants.
const COUNTRY_SECOND_LEVEL = /^(?:co|com|net|org|gov|ac|edu)\.[a-z]{2}$/;

function isMultiTenant(host: string): boolean {
  return MULTI_TENANT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isTooBroadForWildcard(host: string): boolean {
  return COUNTRY_SECOND_LEVEL.test(host) || isMultiTenant(host);
}

interface MediaHostEntry {
  /** Lower-cased host; for a wildcard, the domain below `*.`. */
  host: string;
  wildcard: boolean;
  /** Path prefix starting with `/`, if any. */
  path?: string;
}

/**
 * Parse a `mediaHosts` entry, or `null` when it is not one. An entry names a
 * public DNS host of at least two labels: never an IP literal, `localhost`, a
 * wildcard over a single label (`*.com`), over a country's second-level
 * suffix (`*.co.uk`) or over a multi-tenant hosting domain (`*.amazonaws.com`),
 * a host on such a domain without a path prefix, a port or a scheme. A path
 * prefix names one or more whole segments and ends in `/`, without dot
 * segments, empty segments or encoded separators.
 */
export function parseMediaHostEntry(entry: string): MediaHostEntry | null {
  const wildcard = entry.startsWith("*.");
  const rest = wildcard ? entry.slice(2) : entry;
  const slash = rest.indexOf("/");
  const host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  const path = slash < 0 ? undefined : rest.slice(slash);
  if (wildcard && path !== undefined) return null;

  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  const last = labels[labels.length - 1];
  if (NUMERIC_LABEL.test(last) || last === "localhost") return null;
  if (wildcard && isTooBroadForWildcard(host)) return null;
  if (!wildcard && path === undefined && isMultiTenant(host)) return null;

  if (path !== undefined) {
    // Without the closing slash `/jamcams` would also admit `/jamcams-evil/`.
    if (!path.endsWith("/") || ENCODED_SEPARATOR.test(path)) return null;
    const named = path.slice(1, -1).split("/");
    if (!named.every((s) => PATH_SEGMENT.test(s) && s !== "." && s !== "..")) return null;
  }
  return { host, wildcard, ...(path !== undefined ? { path } : {}) };
}

/**
 * Whether `url` is an image a data source's `mediaHosts` admit. An entry is
 * an exact host (`weathercam.digitraffic.fi`), a subdomain wildcard
 * (`*.thb.gov.tw`, which never matches `thb.gov.tw` itself) or a host with a
 * path prefix (`s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/`). Hosts
 * compare lower-cased. Only http(s) URLs on the scheme's default port and
 * without credentials match: an entry names a host, never a port. An entry
 * the manifest rules would refuse matches nothing.
 */
export function matchesMediaHost(url: string | URL, hosts: readonly string[]): boolean {
  const href = String(url);
  if (!URL.canParse(href)) return false;
  const u = new URL(href);
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username !== "" || u.password !== "") return false;
  // The URL parser drops a scheme's default port, so any port left is another one.
  if (u.port !== "") return false;
  const host = u.hostname.toLowerCase();
  return hosts.some((raw) => {
    const entry = parseMediaHostEntry(raw);
    if (!entry) return false;
    const hostMatches = entry.wildcard ? host.endsWith(`.${entry.host}`) : host === entry.host;
    if (!hostMatches) return false;
    if (entry.path === undefined) return true;
    // The parser has resolved dot segments, so a prefix cannot be climbed out
    // of by `..`; an encoded one could still be decoded upstream. The prefix
    // is compared as whole segments even if an entry lacked its closing slash.
    const prefix = entry.path.endsWith("/") ? entry.path : `${entry.path}/`;
    return u.pathname.startsWith(prefix) && !ENCODED_SEPARATOR.test(u.pathname);
  });
}
