import { withAffiliate } from "../affiliate.js";
import { enc, slugify, term } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

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

export const woltProvider: DeliveryProvider = {
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
  build(q, config) {
    const iso3 = q.countryCode ? ISO2_TO_ISO3[q.countryCode] : undefined;
    const city = q.city ? slugify(q.city) : "";
    // City-scoped search — without the country/city path Wolt defaults to its
    // own last-used city (e.g. Berlin), showing the wrong restaurant.
    const url =
      iso3 && city
        ? `https://wolt.com/en/${iso3}/${city}/search?q=${enc(q.name)}`
        : `https://wolt.com/en/search?q=${term(q)}`;
    return withAffiliate("wolt", url, config);
  },
};
