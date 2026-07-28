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
  const values = new Set(
    [
      taxonomy.basicCategory,
      taxonomy.primary,
      ...(taxonomy.hierarchy ?? []),
      ...(taxonomy.alternates ?? []),
    ].filter((value): value is string => Boolean(value)),
  );
  for (const [category, concepts] of Object.entries(categoryConcepts)) {
    if (concepts.some((concept) => values.has(concept))) return category;
  }
  return undefined;
}
