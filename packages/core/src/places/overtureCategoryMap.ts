// This is deliberately a small interoperability bridge, not a copy of
// Overture's taxonomy. Each OpenMapX UI category points at one or more stable,
// broad Overture concepts (aligned with Overture's 2026-09-23.0 taxonomy while
// retaining pre-rename terms for older 2026 snapshots). Matching descendants is
// delegated to the hierarchy shipped on every Overture place, so new or renamed
// leaves do not require a generated catalog in this repository.
const categoryConcepts: Record<string, string[]> = {
  restaurants: ["restaurant", "fast_food_restaurant"],
  cafes: ["cafe", "coffee_shop", "tea_room", "tea_house"],
  bars: ["bar", "pub", "beer_garden"],
  hotels: ["hotel", "hostel", "bed_and_breakfast", "guest_house"],
  supermarkets: ["grocery_store", "supermarket"],
  banks: ["bank", "credit_union", "bank_or_credit_union"],
  fuel: ["gas_station"],
  shopping_malls: ["shopping_mall", "department_store"],
  bookstores: ["bookstore"],
  pharmacies: ["pharmacy"],
  bakeries: ["bakery", "patisserie_cake_shop"],
  nightlife: ["dance_club", "nightlife_venue", "casino", "night_club"],
  gyms: ["gym", "fitness_studio", "fitness_center"],
  hairdressers: ["hair_salon", "barber", "barber_shop", "beauty_salon"],
  laundromats: ["laundromat", "laundry_service"],
  opticians: ["eyewear_store", "optometry", "optician"],
  car_rental: ["car_rental_service", "car_rental"],
  car_repair: [
    "automotive_repair",
    "auto_repair_service",
    "auto_body_shop",
    "auto_repair",
    "car_repair",
  ],
  veterinarians: ["veterinary_care", "veterinarian"],
  markets: ["market", "farmers_market"],
  cinemas: ["movie_theater", "cinema"],
  doctors: [
    "doctors_office",
    "primary_care_or_general_clinic",
    "specialized_health_care",
    "pediatric_clinic",
    "urgent_care_clinic",
    "walk_in_clinic",
    "doctor",
    "medical_clinic",
  ],
  dentists: ["dental_clinic", "dentist"],
  hospitals: ["hospital"],
  museums: ["museum"],
};

export const OVERTURE_COMMERCIAL_CATEGORIES = Object.freeze(Object.keys(categoryConcepts));

export interface OvertureTaxonomyValues {
  basicCategory?: string | null;
  primary?: string | null;
  hierarchy?: string[] | null;
  alternates?: string[] | null;
}

/** Broad Overture concepts used to query one OpenMapX UI category. */
export function openMapXCategoryToOvertureConcepts(category: string): string[] {
  return categoryConcepts[category] ?? [];
}

/**
 * Resolves a place to an OpenMapX UI category using Overture's own hierarchy.
 * Specific taxonomy leaves never need to be enumerated here.
 */
export function overtureTaxonomyToOpenMapX(taxonomy: OvertureTaxonomyValues): string | undefined {
  return overtureTaxonomyCategoryEvidence(taxonomy).category;
}

/** Pair the existing selected concept with the concrete properties supplying it.
 * Unmatched/absent taxonomy fields cannot supply the resulting category, and
 * indexed pointers preserve the upstream's most-specific array provenance.
 * With a retained category, project its concept rather than the global winner;
 * an unproven host-only criterion has no upstream property evidence. */
export function overtureTaxonomyCategoryEvidence(
  taxonomy: OvertureTaxonomyValues,
  retainedCategory?: string,
): {
  category?: string;
  propertyPointers: string[];
} {
  const values = [
    { value: taxonomy.basicCategory, pointer: "/basic_category" },
    { value: taxonomy.primary, pointer: "/taxonomy/primary" },
    ...(taxonomy.hierarchy ?? []).map((value, index) => ({
      value,
      pointer: `/taxonomy/hierarchy/${index}`,
    })),
    ...(taxonomy.alternates ?? []).map((value, index) => ({
      value,
      pointer: `/taxonomy/alternates/${index}`,
    })),
  ];
  const categories =
    retainedCategory === undefined
      ? Object.entries(categoryConcepts)
      : [[retainedCategory, categoryConcepts[retainedCategory] ?? []] as const];
  for (const [category, concepts] of categories) {
    const concept = concepts.find((concept) => values.some((item) => item.value === concept));
    if (concept)
      return {
        category,
        propertyPointers: values
          .filter((item) => item.value === concept)
          .map((item) => item.pointer),
      };
  }
  return { propertyPointers: [] };
}
