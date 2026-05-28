import type { SearchResult } from "@integrations/geocoding/types";
import type { CategoryPlace } from "@integrations/poi-search/types";

/**
 * Adapts a geocoder SearchResult to the CategoryPlace shape so free-text
 * results render through the same panel + markers as category results.
 * The first comma-separated label segment is the name; the remainder is
 * treated as the address.
 */
export function searchResultToCategoryPlace(result: SearchResult): CategoryPlace {
  const [first, ...rest] = result.label.split(",");
  const address = rest.join(",").trim();
  return {
    id: result.id,
    name: first.trim(),
    coordinates: result.coordinates,
    address: address.length > 0 ? address : undefined,
  };
}
