import type { Place } from "@openmapx/core";

type FallbackBehavior = "always" | "category-gated" | "direct-only";

interface FallbackPolicy {
  behavior: FallbackBehavior;
  categoryWords?: readonly string[];
  osmTags?: Partial<
    Record<"amenity" | "historic" | "leisure" | "shop" | "tourism", readonly string[]>
  >;
}

const TRIPADVISOR_CATEGORY_WORDS = [
  "activity",
  "activities",
  "attraction",
  "attractions",
  "bar",
  "bars",
  "beach",
  "beaches",
  "cafe",
  "cafes",
  "camping",
  "hotel",
  "hotels",
  "museum",
  "museums",
  "nightlife",
  "pub",
  "pubs",
  "restaurant",
  "restaurants",
  "tourism",
  "viewpoint",
  "viewpoints",
] as const;

const TRIPADVISOR_AMENITIES = [
  "bar",
  "biergarten",
  "cafe",
  "cinema",
  "fast_food",
  "food_court",
  "ice_cream",
  "pub",
  "restaurant",
  "theatre",
] as const;

const TRIPADVISOR_TOURISM_VALUES = [
  "alpine_hut",
  "apartment",
  "aquarium",
  "artwork",
  "attraction",
  "camp_site",
  "caravan_site",
  "gallery",
  "guest_house",
  "hostel",
  "hotel",
  "motel",
  "museum",
  "theme_park",
  "viewpoint",
  "wilderness_hut",
  "zoo",
] as const;

export const REVIEW_LINK_FALLBACK_POLICIES = {
  googleMaps: {
    behavior: "always",
  },
  yelp: {
    behavior: "category-gated",
    categoryWords: [
      ...TRIPADVISOR_CATEGORY_WORDS,
      "bakeries",
      "bakery",
      "bookstore",
      "bookstores",
      "dentist",
      "dentists",
      "doctor",
      "doctors",
      "gym",
      "gyms",
      "hairdresser",
      "hairdressers",
      "laundromat",
      "laundromats",
      "market",
      "markets",
      "optician",
      "opticians",
      "shopping",
      "shopping_mall",
      "shopping_malls",
      "supermarket",
      "supermarkets",
      "veterinarian",
      "veterinarians",
    ],
    osmTags: {
      amenity: [...TRIPADVISOR_AMENITIES, "clinic", "dentist", "doctors", "veterinary"],
      historic: ["castle", "monument"],
      leisure: ["fitness_centre", "theme_park", "water_park"],
      shop: [
        "bakery",
        "beauty",
        "books",
        "hairdresser",
        "laundry",
        "mall",
        "optician",
        "supermarket",
      ],
      tourism: TRIPADVISOR_TOURISM_VALUES,
    },
  },
  tripadvisor: {
    behavior: "category-gated",
    categoryWords: TRIPADVISOR_CATEGORY_WORDS,
    osmTags: {
      amenity: TRIPADVISOR_AMENITIES,
      historic: ["castle", "monument"],
      leisure: ["theme_park", "water_park"],
      tourism: TRIPADVISOR_TOURISM_VALUES,
    },
  },
  foursquare: {
    behavior: "direct-only",
  },
  instagram: {
    behavior: "direct-only",
  },
  facebook: {
    behavior: "direct-only",
  },
} satisfies Record<string, FallbackPolicy>;

type ReviewLinkFallbackScheme = keyof typeof REVIEW_LINK_FALLBACK_POLICIES;

function categoryWords(value: string | undefined): Set<string> {
  return new Set(
    value
      ?.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean) ?? [],
  );
}

function hasEligibleCategoryWord(place: Place, policy: FallbackPolicy): boolean {
  if (!policy.categoryWords?.length) return false;

  const eligible = new Set(policy.categoryWords);
  for (const word of [...categoryWords(place.category), ...categoryWords(place.rawCategory)]) {
    if (eligible.has(word)) return true;
  }
  return false;
}

function hasEligibleOsmTag(place: Place, policy: FallbackPolicy): boolean {
  const osmTags = place.osmTags ?? {};
  for (const [key, values] of Object.entries(policy.osmTags ?? {})) {
    const actual = osmTags[key];
    if (actual && values.includes(actual)) return true;
  }
  return false;
}

function isFallbackScheme(scheme: string): scheme is ReviewLinkFallbackScheme {
  return scheme in REVIEW_LINK_FALLBACK_POLICIES;
}

export function shouldBuildReviewFallbackSearch(scheme: string, place: Place): boolean {
  if (!isFallbackScheme(scheme)) return false;

  const policy = REVIEW_LINK_FALLBACK_POLICIES[scheme];
  if (policy.behavior === "always") return true;
  if (policy.behavior === "direct-only") return false;
  return hasEligibleCategoryWord(place, policy) || hasEligibleOsmTag(place, policy);
}
