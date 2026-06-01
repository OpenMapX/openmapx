import { withAffiliate } from "../affiliate.js";
import { slugify } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

export const glovoProvider: DeliveryProvider = {
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
  build(q, config) {
    // `?search=` is dropped on the redirect to /en. The city landing
    // (`/en/<country>/<city>`) is a real, region-scoped restaurant listing.
    const url =
      q.countryCode && q.city
        ? `https://glovoapp.com/en/${q.countryCode}/${slugify(q.city)}`
        : "https://glovoapp.com/en/";
    return withAffiliate("glovo", url, config);
  },
};
