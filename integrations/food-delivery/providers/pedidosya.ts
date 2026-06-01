import { withAffiliate } from "../affiliate.js";
import { slugify } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

/**
 * PedidosYa country host. Chile is the `.cl` exception; every other market is
 * `pedidosya.com.<cc>`. The bare `pedidosya.com` is a country-picker — avoid.
 */
function pedidosyaHost(cc?: string): string {
  if (!cc) return "www.pedidosya.com";
  if (cc === "cl") return "www.pedidosya.cl";
  return `www.pedidosya.com.${cc}`;
}

export const pedidosyaProvider: DeliveryProvider = {
  id: "pedidosya",
  name: "PedidosYa",
  homepage: "https://www.pedidosya.com/",
  color: "#FA0050",
  regions: ["ar", "uy", "bo", "py", "cl", "pe", "ec", "ve", "do", "pa", "gt", "cr", "ni", "hn"],
  build(q, config) {
    // No name-search route exists (`/search?q=` 404s). The city restaurant
    // listing is the best buildable target; the country host is mandatory
    // (bare pedidosya.com is a country-picker).
    const host = pedidosyaHost(q.countryCode);
    const url = q.city ? `https://${host}/restaurantes/${slugify(q.city)}` : `https://${host}/`;
    return withAffiliate("pedidosya", url, config);
  },
};
