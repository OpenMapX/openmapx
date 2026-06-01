import { haversineKm } from "@openmapx/core/server";
import type { DeliveryProvider, DeliveryProviderConfig, DeliveryQuery } from "./types.js";

const enc = encodeURIComponent;

/** `name` (+ city), URL-encoded — for platforms with only a generic text search. */
function term(q: DeliveryQuery): string {
  return enc([q.name, q.city].filter(Boolean).join(" ").trim());
}

/** Lowercase and strip combining diacritics (Münster → munster). */
function foldDiacritics(input: string): string {
  return input.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Slugify a place/city name the way Wolt and Lieferando do in their URL paths:
 * strip diacritics (Münster → munster, Düsseldorf → dusseldorf), lowercase,
 * collapse anything non-alphanumeric to single hyphens.
 */
function slugify(input: string): string {
  return foldDiacritics(input)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Slug for restaurant/brand-page paths (Zomato, Talabat). Apostrophes are
 * dropped entirely rather than hyphenated, matching the platforms' own slugs:
 * "Karim's" → "karims" (not "karim-s"), "McDonald's" → "mcdonalds".
 */
function brandSlug(input: string): string {
  return slugify(input.replace(/['’`]/g, ""));
}

/** ISO-3166-1 alpha-2 → alpha-3 (lowercase), for the Wolt path segment. */
const ISO2_TO_ISO3: Record<string, string> = {
  de: "deu",
  at: "aut",
  fi: "fin",
  se: "swe",
  dk: "dnk",
  no: "nor",
  ee: "est",
  lv: "lva",
  lt: "ltu",
  pl: "pol",
  cz: "cze",
  sk: "svk",
  hu: "hun",
  gr: "grc",
  cy: "cyp",
  hr: "hrv",
  rs: "srb",
  si: "svn",
  ge: "geo",
  az: "aze",
  kz: "kaz",
  il: "isr",
  jp: "jpn",
  mt: "mlt",
  lu: "lux",
  al: "alb",
};

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
 * Country (ISO-2) → Rappi country TLD. Bare `rappi.com` 302-redirects to a
 * country homepage and DROPS the `?query=`, so the country domain is mandatory.
 */
const RAPPI_TLD: Record<string, string> = {
  mx: "com.mx",
  co: "com.co",
  br: "com.br",
  ar: "com.ar",
  cl: "com.cl",
  pe: "com.pe",
  ec: "com.ec",
  uy: "com.uy",
  cr: "com.cr",
};

/**
 * Country (ISO-2) → foodpanda country host. The global `foodpanda.com` is a
 * country-router, not a storefront. Thailand is intentionally absent —
 * foodpanda exited TH (the domain now redirects to robinhood.co.th).
 */
const FOODPANDA_HOST: Record<string, string> = {
  sg: "foodpanda.sg",
  my: "foodpanda.my",
  hk: "foodpanda.hk",
  tw: "foodpanda.com.tw",
  pk: "foodpanda.pk",
  bd: "foodpanda.com.bd",
  ph: "foodpanda.ph",
  kh: "foodpanda.com.kh",
  la: "foodpanda.la",
  mm: "foodpanda.com.mm",
};

/**
 * Country (ISO-2) → Talabat URL country segment (e.g. ae → `/uae/`). Iraq is
 * special — it lives on the `iraq.talabat.com` subdomain, handled in build().
 */
const TALABAT_COUNTRY: Record<string, string> = {
  ae: "uae",
  sa: "ksa",
  kw: "kuwait",
  bh: "bahrain",
  qa: "qatar",
  om: "oman",
  eg: "egypt",
  jo: "jordan",
};

/** Country (ISO-2) → Deliveroo country domain. */
const DELIVEROO_DOMAIN: Record<string, string> = {
  gb: "deliveroo.co.uk",
  ie: "deliveroo.ie",
  fr: "deliveroo.fr",
  it: "deliveroo.it",
  be: "deliveroo.be",
  ae: "deliveroo.ae",
  kw: "deliveroo.com.kw",
  qa: "deliveroo.com.qa",
  sg: "deliveroo.com.sg",
  hk: "deliveroo.hk",
};

/** Country (ISO-2) → Just Eat country domain. */
const JUSTEAT_DOMAIN: Record<string, string> = {
  gb: "just-eat.co.uk",
  ie: "just-eat.ie",
  es: "just-eat.es",
  it: "justeat.it",
  dk: "just-eat.dk",
  ch: "just-eat.ch",
};

/**
 * PedidosYa country host. Chile is the `.cl` exception; every other market is
 * `pedidosya.com.<cc>`. The bare `pedidosya.com` is a country-picker — avoid.
 */
function pedidosyaHost(cc?: string): string {
  if (!cc) return "www.pedidosya.com";
  if (cc === "cl") return "www.pedidosya.cl";
  return `www.pedidosya.com.${cc}`;
}

/**
 * Map an OSM city name to Zomato's city-slug. Most Indian cities are the
 * lowercased name, but the Delhi metro shares one slug (`ncr`) and Bengaluru
 * keeps its older `bangalore` slug.
 */
function zomatoCitySlug(city: string): string {
  const s = slugify(city);
  if (["delhi", "new-delhi", "gurgaon", "gurugram", "noida", "ghaziabad", "faridabad"].includes(s))
    return "ncr";
  if (s === "bengaluru") return "bangalore";
  return s;
}

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

interface UberFeedItem {
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

/** Lowercase, strip diacritics, collapse non-alphanumerics — for name matching. */
function normalizeName(s: string): string {
  return foldDiacritics(s)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
 * degrades gracefully. See docs/plans/restaurant-menus-and-delivery.md.
 */
export async function resolveUberEatsStoreUrl(q: DeliveryQuery): Promise<string | null> {
  const loc = buildUberEatsLocation(q);
  if (!loc) return null;
  const cc = q.countryCode ?? "us";
  try {
    const res = await fetch(`https://www.ubereats.com/_p/api/getFeedV1?localeCode=${enc(cc)}`, {
      method: "POST",
      signal: AbortSignal.timeout(UBEREATS_RESOLVE_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "x",
        "accept-language": cc,
        "user-agent": UBEREATS_UA,
        cookie: `uev2.loc=${encodeURIComponent(JSON.stringify(loc))}`,
      },
      body: JSON.stringify({
        userQuery: q.name,
        pageInfo: { offset: 0, pageSize: 80 },
        diningMode: "DELIVERY",
        source: "manual",
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as UberFeedResponse;
    const items = json.data?.feedItems;
    if (!Array.isArray(items)) return null;
    const target = normalizeName(q.name);
    if (!target) return null;

    // Collect every name-matching store with a usable /store/ URL.
    const matches: Array<{ url: string; lat?: number; lng?: number }> = [];
    for (const it of items) {
      if (it.type !== "REGULAR_STORE") continue;
      const url = it.store?.actionUrl;
      if (typeof url !== "string" || !url.startsWith("/store/")) continue;
      const title = normalizeName(it.store?.title?.text ?? "");
      if (title && (title.includes(target) || target.includes(title))) {
        matches.push({
          url,
          lat: it.store?.mapMarker?.latitude,
          lng: it.store?.mapMarker?.longitude,
        });
      }
    }
    if (matches.length === 0) return null;

    // Disambiguate same-named branches by proximity to the queried coordinates.
    const ranked = matches
      .map((m) => ({
        url: m.url,
        km:
          typeof m.lat === "number" && typeof m.lng === "number"
            ? haversineKm(q.lat as number, q.lng as number, m.lat, m.lng)
            : Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => a.km - b.km);

    const best = ranked[0];
    // If no candidate has marker coords, ranked distances are all Infinity →
    // fall back to the first match (best we can do without location signal).
    if (!Number.isFinite(best.km)) return toUberStoreUrl(matches[0].url, cc);
    // Reject a too-far nearest match: the real branch isn't listed.
    if (best.km > UBEREATS_MAX_MATCH_KM) return null;
    return toUberStoreUrl(best.url, cc);
  } catch {
    return null;
  }
}

interface ProviderSpec {
  id: string;
  name: string;
  homepage: string;
  color: string;
  regions: readonly string[] | "*";
  /** Build the best location-aware deep link for this platform. */
  build: (q: DeliveryQuery) => string;
}

/**
 * Platform registry. Each builder produces the most location-scoped URL the
 * platform supports so results land on the right city (see
 * docs/plans/restaurant-menus-and-delivery.md). Order is the default UI order.
 */
const SPECS: readonly ProviderSpec[] = [
  {
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
    build: (q) => {
      const cc = q.countryCode ?? "us";
      const prefix = cc === "us" ? "" : `/${cc}`;
      const pl = buildUberEatsPl(q);
      if (pl) {
        return `https://www.ubereats.com${prefix}/feed?diningMode=DELIVERY&pl=${enc(pl)}&q=${enc(q.name)}`;
      }
      return `https://www.ubereats.com${prefix}/search?q=${term(q)}`;
    },
  },
  {
    id: "wolt",
    name: "Wolt",
    homepage: "https://wolt.com/",
    color: "#00C2E8",
    regions: [
      "de",
      "at",
      "fi",
      "se",
      "dk",
      "no",
      "ee",
      "lv",
      "lt",
      "pl",
      "cz",
      "sk",
      "hu",
      "gr",
      "cy",
      "hr",
      "rs",
      "si",
      "ge",
      "az",
      "kz",
      "il",
      "jp",
      "mt",
      "lu",
      "al",
    ],
    build: (q) => {
      const iso3 = q.countryCode ? ISO2_TO_ISO3[q.countryCode] : undefined;
      const city = q.city ? slugify(q.city) : "";
      // City-scoped search — without the country/city path Wolt defaults to its
      // own last-used city (e.g. Berlin), showing the wrong restaurant.
      if (iso3 && city) return `https://wolt.com/en/${iso3}/${city}/search?q=${enc(q.name)}`;
      return `https://wolt.com/en/search?q=${term(q)}`;
    },
  },
  {
    id: "lieferando",
    name: "Lieferando",
    homepage: "https://www.lieferando.de/",
    color: "#FF8000",
    regions: ["de", "at"],
    build: (q) => {
      const domain = q.countryCode === "at" ? "lieferando.at" : "lieferando.de";
      // `/en/takeaway/<city>` is not a real route. The city landing page is
      // `/lieferservice-<city>` (the user then enters their street address).
      if (q.city) return `https://www.${domain}/lieferservice-${slugify(q.city)}`;
      return `https://www.${domain}/`;
    },
  },
  {
    id: "doordash",
    name: "DoorDash",
    homepage: "https://www.doordash.com/",
    color: "#FF3008",
    regions: ["us", "ca", "au", "nz", "jp"],
    build: (q) => `https://www.doordash.com/search/store/${term(q)}/`,
  },
  {
    id: "deliveroo",
    name: "Deliveroo",
    homepage: "https://deliveroo.co.uk/",
    color: "#00CCBC",
    regions: ["gb", "ie", "fr", "it", "be", "ae", "kw", "qa", "sg", "hk"],
    // Deliveroo is address-first with no public name-search URL (`/search?q=`
    // 404s). The city hub (`/cities/<city>`) is a real, server-rendered listing
    // of that city's restaurants; fall back to the country homepage otherwise.
    build: (q) => {
      const domain = (q.countryCode && DELIVEROO_DOMAIN[q.countryCode]) ?? "deliveroo.co.uk";
      if (q.city) return `https://${domain}/cities/${slugify(q.city)}/`;
      return `https://${domain}/`;
    },
  },
  {
    id: "justeat",
    name: "Just Eat",
    homepage: "https://www.just-eat.co.uk/",
    color: "#F36D00",
    regions: ["gb", "ie", "es", "it", "dk", "ch"],
    // `/search?q=` is not a real Just Eat route. UK/IE expose a city takeaway
    // landing (`/takeaway/<city>`); other markets only get the country homepage
    // (their listing paths differ per locale and aren't reliably buildable).
    build: (q) => {
      const domain = (q.countryCode && JUSTEAT_DOMAIN[q.countryCode]) ?? "just-eat.co.uk";
      if ((q.countryCode === "gb" || q.countryCode === "ie") && q.city)
        return `https://www.${domain}/takeaway/${slugify(q.city)}`;
      return `https://www.${domain}/`;
    },
  },
  {
    id: "glovo",
    name: "Glovo",
    homepage: "https://glovoapp.com/",
    color: "#F9C200",
    regions: [
      "es",
      "it",
      "pt",
      "pl",
      "ua",
      "ge",
      "ke",
      "ng",
      "ci",
      "ma",
      "ro",
      "bg",
      "hr",
      "rs",
      "ba",
      "md",
      "kz",
      "kg",
      "am",
    ],
    // `?search=` is dropped on the redirect to /en. The city landing
    // (`/en/<country>/<city>`) is a real, region-scoped restaurant listing.
    build: (q) => {
      if (q.countryCode && q.city)
        return `https://glovoapp.com/en/${q.countryCode}/${slugify(q.city)}`;
      return "https://glovoapp.com/en/";
    },
  },
  {
    id: "foodpanda",
    name: "foodpanda",
    homepage: "https://www.foodpanda.com/",
    color: "#D70F64",
    regions: ["sg", "my", "ph", "tw", "hk", "pk", "bd", "kh", "la", "mm"],
    // The global `foodpanda.com` is a country-router, and `?q=` is ignored. Use
    // the country host + city landing; Thailand is dropped (foodpanda exited).
    build: (q) => {
      const host = q.countryCode ? FOODPANDA_HOST[q.countryCode] : undefined;
      if (!host) return "https://www.foodpanda.com/";
      if (q.city) return `https://www.${host}/city/${slugify(q.city)}`;
      return `https://www.${host}/`;
    },
  },
  {
    id: "grubhub",
    name: "Grubhub",
    homepage: "https://www.grubhub.com/",
    color: "#EB1700",
    regions: ["us"],
    build: (q) => `https://www.grubhub.com/search?queryText=${term(q)}`,
  },
  {
    id: "ifood",
    name: "iFood",
    homepage: "https://www.ifood.com.br/",
    color: "#EA1D2C",
    regions: ["br"],
    build: (q) => `https://www.ifood.com.br/busca?q=${term(q)}`,
  },
  {
    id: "rappi",
    name: "Rappi",
    homepage: "https://www.rappi.com/",
    color: "#FE3008",
    regions: ["mx", "co", "br", "ar", "cl", "pe", "ec", "uy", "cr"],
    // Bare `rappi.com` 302s to a country homepage and drops the query — the
    // country TLD is mandatory. `/search?query=` is server-rendered and scopes
    // to the domain's city; city comes from the storefront, so query = name.
    build: (q) => {
      const tld = (q.countryCode && RAPPI_TLD[q.countryCode]) ?? "com.mx";
      return `https://www.rappi.${tld}/search?query=${enc(q.name)}`;
    },
  },
  {
    id: "pedidosya",
    name: "PedidosYa",
    homepage: "https://www.pedidosya.com/",
    color: "#FA0050",
    regions: ["ar", "uy", "bo", "py", "cl", "pe", "ec", "ve", "do", "pa", "gt", "cr", "ni", "hn"],
    // No name-search route exists (`/search?q=` 404s). The city restaurant
    // listing is the best buildable target; the country host is mandatory
    // (bare pedidosya.com is a country-picker).
    build: (q) => {
      const host = pedidosyaHost(q.countryCode);
      if (q.city) return `https://${host}/restaurantes/${slugify(q.city)}`;
      return `https://${host}/`;
    },
  },
  {
    id: "swiggy",
    name: "Swiggy",
    homepage: "https://www.swiggy.com/",
    color: "#FC8019",
    regions: ["in"],
    build: (q) => `https://www.swiggy.com/search?query=${term(q)}`,
  },
  {
    id: "zomato",
    name: "Zomato",
    homepage: "https://www.zomato.com/",
    color: "#E23744",
    regions: ["in", "ae"],
    // `/search?q=` 404s, and Zomato has exited every market except India
    // (ordering) + UAE (discovery). The brand page (`/<city>/restaurants/<name>`)
    // lists that brand's outlets in the city and opens the exact restaurant when
    // present; falls back to the city listing, then the homepage.
    build: (q) => {
      const city = q.city ? zomatoCitySlug(q.city) : "";
      const nameSlug = brandSlug(q.name);
      if (city && nameSlug) return `https://www.zomato.com/${city}/restaurants/${nameSlug}`;
      if (city) return `https://www.zomato.com/${city}/restaurants`;
      return "https://www.zomato.com/";
    },
  },
  {
    id: "talabat",
    name: "Talabat",
    homepage: "https://www.talabat.com/",
    color: "#FF5A00",
    regions: ["ae", "sa", "kw", "bh", "qa", "om", "eg", "jo", "iq"],
    // `/search?q=` 404s. The name-slug brand page (`/<country>/<name>`) opens
    // the exact restaurant when it's on Talabat; Iraq is on its own subdomain.
    build: (q) => {
      const cc = q.countryCode;
      const nameSlug = brandSlug(q.name);
      if (cc === "iq") {
        // Iraq is a separate subdomain that doesn't serve the `/<name>` brand
        // pages (those 404), so hand off to its storefront root.
        return "https://iraq.talabat.com/";
      }
      const country = cc ? TALABAT_COUNTRY[cc] : undefined;
      if (!country) return "https://www.talabat.com/";
      if (nameSlug) return `https://www.talabat.com/${country}/${nameSlug}`;
      return `https://www.talabat.com/${country}/restaurants`;
    },
  },
];

/**
 * Apply an operator-configured affiliate wrapper, if one exists for this
 * provider. The template must contain `{url}`, replaced with the URL-encoded
 * destination. No template ⇒ the plain link is returned unchanged.
 */
function withAffiliate(id: string, url: string, config: DeliveryProviderConfig): string {
  const tmpl = config.affiliateTemplates?.[id]?.trim();
  if (!tmpl?.includes("{url}")) return url;
  return tmpl.replace("{url}", enc(url));
}

export const DELIVERY_PROVIDERS: readonly DeliveryProvider[] = SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  homepage: spec.homepage,
  color: spec.color,
  regions: spec.regions,
  build(query: DeliveryQuery, config: DeliveryProviderConfig): string {
    let url = spec.build(query);
    if (spec.id === "ubereats" && config.uberEatsScid?.trim()) {
      url += `${url.includes("?") ? "&" : "?"}scid=${enc(config.uberEatsScid.trim())}`;
    }
    return withAffiliate(spec.id, url, config);
  },
  // Uber Eats: resolve the precise /store/ page server-side; everyone else
  // relies on build()'s location-scoped deep link.
  ...(spec.id === "ubereats"
    ? {
        async resolve(
          query: DeliveryQuery,
          config: DeliveryProviderConfig,
        ): Promise<string | null> {
          const url = await resolveUberEatsStoreUrl(query);
          if (!url) return null;
          let out = url;
          if (config.uberEatsScid?.trim()) {
            out += `?scid=${enc(config.uberEatsScid.trim())}`;
          }
          return withAffiliate(spec.id, out, config);
        },
      }
    : {}),
}));

export function getDeliveryProvider(id: string): DeliveryProvider | undefined {
  return DELIVERY_PROVIDERS.find((p) => p.id === id);
}

/** Whether a provider serves the given country (or is global). */
export function providerServes(provider: DeliveryProvider, countryCode?: string): boolean {
  if (provider.regions === "*") return true;
  if (!countryCode) return true; // no country known ⇒ don't pre-filter
  return provider.regions.includes(countryCode.toLowerCase());
}
