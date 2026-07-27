import { withAffiliate } from "../affiliate.js";
import { slugify } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

export const lieferandoProvider: DeliveryProvider = {
  id: "lieferando",
  name: "Lieferando",
  homepage: "https://www.lieferando.de/",
  color: "#FF8000",
  fallbackKind: "browse",
  regions: ["de", "at"],
  build(q, config) {
    const domain = q.countryCode === "at" ? "lieferando.at" : "lieferando.de";
    // `/en/takeaway/<city>` is not a real route. The city landing page is
    // `/lieferservice-<city>` (the user then enters their street address).
    const url = q.city
      ? `https://www.${domain}/lieferservice-${slugify(q.city)}`
      : `https://www.${domain}/`;
    return withAffiliate("lieferando", url, config);
  },
};
