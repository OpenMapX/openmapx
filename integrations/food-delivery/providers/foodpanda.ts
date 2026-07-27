import { withAffiliate } from "../affiliate.js";
import { slugify } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

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

export const foodpandaProvider: DeliveryProvider = {
  id: "foodpanda",
  name: "foodpanda",
  homepage: "https://www.foodpanda.com/",
  color: "#D70F64",
  fallbackKind: "browse",
  regions: ["sg", "my", "ph", "tw", "hk", "pk", "bd", "kh", "la", "mm"],
  build(q, config) {
    // The global `foodpanda.com` is a country-router, and `?q=` is ignored. Use
    // the country host + city landing; Thailand is dropped (foodpanda exited).
    const host = q.countryCode ? FOODPANDA_HOST[q.countryCode] : undefined;
    let url: string;
    if (!host) url = "https://www.foodpanda.com/";
    else if (q.city) url = `https://www.${host}/city/${slugify(q.city)}`;
    else url = `https://www.${host}/`;
    return withAffiliate("foodpanda", url, config);
  },
};
