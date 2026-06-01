import { withAffiliate } from "../affiliate.js";
import { brandSlug, slugify } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

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

export const zomatoProvider: DeliveryProvider = {
  id: "zomato",
  name: "Zomato",
  homepage: "https://www.zomato.com/",
  color: "#E23744",
  regions: ["in", "ae"],
  build(q, config) {
    // `/search?q=` 404s, and Zomato has exited every market except India
    // (ordering) + UAE (discovery). The brand page (`/<city>/restaurants/<name>`)
    // lists that brand's outlets in the city and opens the exact restaurant when
    // present; falls back to the city listing, then the homepage.
    const city = q.city ? zomatoCitySlug(q.city) : "";
    const nameSlug = brandSlug(q.name);
    let url: string;
    if (city && nameSlug) url = `https://www.zomato.com/${city}/restaurants/${nameSlug}`;
    else if (city) url = `https://www.zomato.com/${city}/restaurants`;
    else url = "https://www.zomato.com/";
    return withAffiliate("zomato", url, config);
  },
};
