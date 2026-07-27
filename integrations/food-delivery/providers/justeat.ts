import { withAffiliate } from "../affiliate.js";
import { slugify } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

/** Country (ISO-2) → Just Eat country domain. */
const JUSTEAT_DOMAIN: Record<string, string> = {
  gb: "just-eat.co.uk",
  ie: "just-eat.ie",
  es: "just-eat.es",
  it: "justeat.it",
  dk: "just-eat.dk",
  ch: "just-eat.ch",
};

export const justeatProvider: DeliveryProvider = {
  id: "justeat",
  name: "Just Eat",
  homepage: "https://www.just-eat.co.uk/",
  color: "#F36D00",
  fallbackKind: "browse",
  regions: ["gb", "ie", "es", "it", "dk", "ch"],
  build(q, config) {
    // `/search?q=` is not a real Just Eat route. UK/IE expose a city takeaway
    // landing (`/takeaway/<city>`); other markets only get the country homepage
    // (their listing paths differ per locale and aren't reliably buildable).
    const domain = (q.countryCode && JUSTEAT_DOMAIN[q.countryCode]) ?? "just-eat.co.uk";
    const url =
      (q.countryCode === "gb" || q.countryCode === "ie") && q.city
        ? `https://www.${domain}/takeaway/${slugify(q.city)}`
        : `https://www.${domain}/`;
    return withAffiliate("justeat", url, config);
  },
};
