import { fetchJson } from "@openmapx/core";
import { haversineKm } from "@openmapx/core/server";
import { withAffiliate } from "../affiliate.js";
import { enc, foldDiacritics, term } from "../slug.js";
import type {
  DeliveryProvider,
  DeliveryProviderConfig,
  DeliveryQuery,
  DeliveryResolveResult,
} from "../types.js";

/** English country names, used only inside the Uber Eats `pl` location blob. */
const COUNTRY_NAMES: Record<string, string> = {
  de: "Germany",
  at: "Austria",
  us: "United States",
  ca: "Canada",
  gb: "United Kingdom",
  ie: "Ireland",
  fr: "France",
  es: "Spain",
  it: "Italy",
  pt: "Portugal",
  be: "Belgium",
  nl: "Netherlands",
  pl: "Poland",
  se: "Sweden",
  jp: "Japan",
  au: "Australia",
  nz: "New Zealand",
  za: "South Africa",
  mx: "Mexico",
  br: "Brazil",
  cl: "Chile",
  in: "India",
};

/**
 * Build the Uber Eats delivery-location object. Verified empirically: only the
 * coordinates plus a free-text address are needed — the Google-Places
 * `reference` may be left empty — so it can be constructed from OSM data alone
 * (no Places API). Used both as the base64 `pl` URL param and as the `uev2.loc`
 * cookie value for the server-side store resolver below.
 */
function buildUberEatsLocation(q: DeliveryQuery): object | null {
  if (typeof q.lat !== "number" || typeof q.lng !== "number") return null;
  const address1 = (q.address?.split(",")[0] ?? q.city ?? "").trim();
  const subtitle = q.address ?? [q.postcode, q.city].filter(Boolean).join(" ").trim();
  return {
    address: {
      address1,
      address2: subtitle,
      aptOrSuite: "",
      city: q.city ?? "",
      country: q.countryCode ? (COUNTRY_NAMES[q.countryCode] ?? "") : "",
      postalCode: q.postcode ?? "",
      region: "",
      subtitle,
      title: address1 || (q.city ?? ""),
      uuid: "",
    },
    latitude: q.lat,
    longitude: q.lng,
    reference: "",
    referenceType: "google_places",
    type: "google_places",
    source: "manual_auto_complete",
  };
}

/** base64 `pl` URL param carrying the delivery location. */
function buildUberEatsPl(q: DeliveryQuery): string | null {
  const loc = buildUberEatsLocation(q);
  return loc ? Buffer.from(JSON.stringify(loc), "utf8").toString("base64") : null;
}

const UBEREATS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UBEREATS_RESOLVE_TIMEOUT_MS = 6000;

export interface UberFeedItem {
  type?: string;
  store?: {
    actionUrl?: string;
    title?: { text?: string };
    mapMarker?: { latitude?: number; longitude?: number };
  };
}
interface UberFeedResponse {
  data?: { feedItems?: UberFeedItem[] };
}

/**
 * Max distance (km) between the queried restaurant and a candidate store's map
 * marker for it to count as "the same place". Chain branches in a city sit well
 * over 1 km apart, so this reliably distinguishes the exact branch from a
 * different one while tolerating OSM-vs-Uber coordinate noise. Beyond it, we
 * assume the actual restaurant isn't on Uber Eats and fall back to the
 * location-scoped feed URL rather than linking a wrong branch.
 */
const UBEREATS_MAX_MATCH_KM = 1;

/**
 * A one-word brand followed by Uber's branch label (for example,
 * "Frittenwerk Aachen Holzgraben") is useful evidence only very close to the
 * queried POI. Keeping this radius much tighter than the normal branch radius
 * avoids turning a generic one-word query into a match elsewhere in the city.
 */
const UBEREATS_SINGLE_BRAND_MAX_MATCH_KM = 0.25;
const UBEREATS_SINGLE_BRAND_MIN_LENGTH = 8;
const GENERIC_SINGLE_NAME_TOKENS = new Set([
  "bar",
  "bistro",
  "burger",
  "cafe",
  "diner",
  "grill",
  "imbiss",
  "kebab",
  "pizza",
  "pub",
  "restaurant",
  "sushi",
]);

/** Lowercase, strip diacritics, collapse non-alphanumerics — for name matching. */
function normalizeName(s: string): string {
  return foldDiacritics(s)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function nameScore(target: string, candidate: string): number {
  if (!target || !candidate) return 0;
  if (target === candidate) return 3;
  const targetTokens = target.split(" ").filter(Boolean);
  const candidateTokens = candidate.split(" ").filter(Boolean);
  // Uber commonly appends a city/branch label to one-word brands. Accept that
  // shape only for a distinctive, whole first token; matchUberEatsStoreUrl()
  // additionally requires it to be within a much tighter distance. This finds
  // "Frittenwerk Aachen Holzgraben" without reviving substring mistakes such
  // as "Mo" -> "Moco Chicken" or generic "Pizza" -> "Pizza Hut".
  if (targetTokens.length === 1) {
    const token = targetTokens[0] ?? "";
    return token.length >= UBEREATS_SINGLE_BRAND_MIN_LENGTH &&
      !GENERIC_SINGLE_NAME_TOKENS.has(token) &&
      candidateTokens[0] === token
      ? 1
      : 0;
  }
  const candidateSet = new Set(candidateTokens);
  const targetContained = targetTokens.every((token) => candidateSet.has(token));
  return targetContained ? 2 : 0;
}

function toUberStoreUrl(actionUrl: string, countryCode?: string): string {
  const path = actionUrl.split("?")[0];
  const cc = countryCode ?? "us";
  const prefix = cc === "us" ? "" : `/${cc}`;
  return `https://www.ubereats.com${prefix}${path}`;
}

/**
 * Resolve a restaurant to its exact Uber Eats `/store/<slug>/<uuid>` page — the
 * same canonical URL "Order with Google" links to, which works for logged-out
 * users (unlike the `?pl=` feed URL, which Uber gates behind an address wall).
 * Sets the delivery location as the `uev2.loc` cookie and queries Uber Eats'
 * (undocumented) `getFeedV1` endpoint, then among the name-matching stores picks
 * the one whose map marker is closest to the queried coordinates (chains have
 * many same-named branches in a city, so first-match is not enough). Returns
 * null when the nearest match is farther than {@link UBEREATS_MAX_MATCH_KM} —
 * i.e. this exact restaurant likely isn't on Uber Eats — so the caller falls
 * back to {@link buildUberEatsPl} rather than linking a wrong branch.
 *
 * This is the one place we call a platform's internal API rather than pure
 * deep-linking — justified because it yields the precise store page Google
 * itself uses, is a single cached server-side request to a fixed host, and
 * degrades gracefully.
 */
export function matchUberEatsStoreUrl(
  q: DeliveryQuery,
  items: readonly UberFeedItem[],
): string | null {
  if (typeof q.lat !== "number" || typeof q.lng !== "number") return null;
  const target = normalizeName(q.name);
  if (!target) return null;
  const ranked: Array<{ url: string; score: number; km: number }> = [];
  for (const item of items) {
    if (item.type !== "REGULAR_STORE") continue;
    const actionUrl = item.store?.actionUrl;
    const lat = item.store?.mapMarker?.latitude;
    const lng = item.store?.mapMarker?.longitude;
    if (typeof actionUrl !== "string" || !actionUrl.startsWith("/store/")) continue;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    const score = nameScore(target, normalizeName(item.store?.title?.text ?? ""));
    if (score === 0) continue;
    const km = haversineKm(q.lat, q.lng, lat, lng);
    const maxKm = score === 1 ? UBEREATS_SINGLE_BRAND_MAX_MATCH_KM : UBEREATS_MAX_MATCH_KM;
    if (km <= maxKm) ranked.push({ url: actionUrl, score, km });
  }
  ranked.sort((a, b) => b.score - a.score || a.km - b.km);
  return ranked[0] ? toUberStoreUrl(ranked[0].url, q.countryCode) : null;
}

async function resolveUberEatsStoreUrl(q: DeliveryQuery): Promise<DeliveryResolveResult> {
  const loc = buildUberEatsLocation(q);
  if (!loc) return { kind: "not_found" };
  const cc = q.countryCode ?? "us";
  const json = await fetchJson<UberFeedResponse>(
    `https://www.ubereats.com/_p/api/getFeedV1?localeCode=${enc(cc)}`,
    {
      timeoutMs: UBEREATS_RESOLVE_TIMEOUT_MS,
      userAgent: null,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "x",
        "accept-language": cc,
        "user-agent": UBEREATS_UA,
        cookie: `uev2.loc=${encodeURIComponent(JSON.stringify(loc))}`,
      },
      init: {
        method: "POST",
        body: JSON.stringify({
          userQuery: q.name,
          pageInfo: { offset: 0, pageSize: 80 },
          diningMode: "DELIVERY",
          source: "manual",
        }),
      },
    },
  );
  const items = json.data?.feedItems;
  if (!Array.isArray(items)) throw new Error("Uber Eats feed schema missing feedItems");
  const url = matchUberEatsStoreUrl(q, items);
  return url ? { kind: "exact", url } : { kind: "not_found" };
}

/** Append the operator's Impact click id (`scid`) when configured. */
function appendScid(url: string, config: DeliveryProviderConfig): string {
  const scid = config.uberEatsScid?.trim();
  if (!scid) return url;
  return `${url}${url.includes("?") ? "&" : "?"}scid=${enc(scid)}`;
}

export const uberEatsProvider: DeliveryProvider = {
  id: "ubereats",
  name: "Uber Eats",
  homepage: "https://www.ubereats.com/",
  color: "#06C167",
  regions: [
    "us",
    "ca",
    "gb",
    "ie",
    "fr",
    "es",
    "it",
    "pt",
    "de",
    "at",
    "be",
    "nl",
    "pl",
    "se",
    "jp",
    "au",
    "nz",
    "tw",
    "za",
    "ke",
    "ng",
    "mx",
    "br",
    "cl",
    "ae",
    "sa",
    "in",
  ],
  fallbackKind: "search",
  build(q, config) {
    const cc = q.countryCode ?? "us";
    const prefix = cc === "us" ? "" : `/${cc}`;
    const pl = buildUberEatsPl(q);
    const url = pl
      ? `https://www.ubereats.com${prefix}/search?diningMode=DELIVERY&pl=${enc(pl)}&q=${enc(q.name)}&sc=SEARCH_BAR&searchType=GLOBAL_SEARCH&vertical=ALL`
      : `https://www.ubereats.com${prefix}/search?q=${term(q)}`;
    return withAffiliate("ubereats", appendScid(url, config), config);
  },
  // Resolve the precise /store/ page server-side; everyone else relies on
  // build()'s location-scoped deep link.
  async resolve(q, config) {
    const result = await resolveUberEatsStoreUrl(q);
    if (result.kind === "not_found") return result;
    return {
      kind: "exact",
      url: withAffiliate("ubereats", appendScid(result.url, config), config),
    };
  },
};
