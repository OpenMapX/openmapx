// This is deliberately a small interoperability bridge, not a copy of
// Overture's taxonomy. Each OpenMapX UI category points at one or more stable,
// broad Overture concepts. Matching descendants is delegated to the hierarchy
// shipped on every Overture place, so new or renamed leaves do not require a
// generated catalog in this repository.
const categoryConcepts: Record<string, string[]> = {
  restaurants: ["restaurant"],
  cafes: ["cafe", "coffee_shop", "tea_house"],
  bars: ["bar", "pub"],
  hotels: ["hotel"],
  supermarkets: ["supermarket", "grocery_store"],
  banks: ["bank", "credit_union"],
  fuel: ["gas_station"],
  shopping_malls: ["shopping_mall"],
  bookstores: ["bookstore"],
  pharmacies: ["pharmacy"],
  bakeries: ["bakery"],
  nightlife: ["night_club", "dance_club"],
  gyms: ["gym", "fitness_center"],
  hairdressers: ["hair_salon", "barber_shop"],
  laundromats: ["laundromat", "laundry_service"],
  opticians: ["optician", "eyewear_store"],
  car_rental: ["car_rental"],
  car_repair: ["auto_repair", "car_repair"],
  veterinarians: ["veterinarian"],
  markets: ["market", "farmers_market"],
  cinemas: ["movie_theater", "cinema"],
  doctors: ["doctor", "medical_clinic"],
  dentists: ["dentist"],
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
