import { withAffiliate } from "../affiliate.js";
import { brandSlug } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

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

export const talabatProvider: DeliveryProvider = {
  id: "talabat",
  name: "Talabat",
  homepage: "https://www.talabat.com/",
  color: "#FF5A00",
  regions: ["ae", "sa", "kw", "bh", "qa", "om", "eg", "jo", "iq"],
  build(q, config) {
    // `/search?q=` 404s. The name-slug brand page (`/<country>/<name>`) opens
    // the exact restaurant when it's on Talabat; Iraq is on its own subdomain.
    const cc = q.countryCode;
    const nameSlug = brandSlug(q.name);
    let url: string;
    if (cc === "iq") {
      // Iraq is a separate subdomain that doesn't serve the `/<name>` brand
      // pages (those 404), so hand off to its storefront root.
      url = "https://iraq.talabat.com/";
    } else {
      const country = cc ? TALABAT_COUNTRY[cc] : undefined;
      if (!country) url = "https://www.talabat.com/";
      else if (nameSlug) url = `https://www.talabat.com/${country}/${nameSlug}`;
      else url = `https://www.talabat.com/${country}/restaurants`;
    }
    return withAffiliate("talabat", url, config);
  },
};
