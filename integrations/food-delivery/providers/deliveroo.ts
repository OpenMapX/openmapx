import { withAffiliate } from "../affiliate.js";
import { slugify } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

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

export const deliverooProvider: DeliveryProvider = {
  id: "deliveroo",
  name: "Deliveroo",
  homepage: "https://deliveroo.co.uk/",
  color: "#00CCBC",
  fallbackKind: "browse",
  regions: ["gb", "ie", "fr", "it", "be", "ae", "kw", "qa", "sg", "hk"],
  build(q, config) {
    // Deliveroo is address-first with no public name-search URL (`/search?q=`
    // 404s). The city hub (`/cities/<city>`) is a real, server-rendered listing
    // of that city's restaurants; fall back to the country homepage otherwise.
    const domain = (q.countryCode && DELIVEROO_DOMAIN[q.countryCode]) ?? "deliveroo.co.uk";
    const url = q.city ? `https://${domain}/cities/${slugify(q.city)}/` : `https://${domain}/`;
    return withAffiliate("deliveroo", url, config);
  },
};
