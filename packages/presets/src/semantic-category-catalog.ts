import {
  CATEGORY_DEFINITIONS,
  CATEGORY_FILTERS,
  categoriesToFilter,
  normalizeFilter,
  type OverpassFilter,
} from "@openmapx/core";
import { loadEditorIndex, normalizeEditorText } from "./editor-loader";

export type SemanticCategoryLanguage = "en" | "de";

export interface SemanticCategoryDocument {
  categoryId: string;
  labels: Readonly<Record<SemanticCategoryLanguage, string>>;
  document: string;
  filter: OverpassFilter;
}

const SHARED_SELECTOR_OWNER: Readonly<Record<string, string>> = Object.freeze({
  "amenity=bar": "bars",
  "amenity=cafe": "cafes",
  "amenity=pub": "bars",
  "leisure=park": "parks",
});

const GERMAN_CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  activities: "Aktivitäten",
  aeds: "Defibrillatoren",
  airports: "Flughäfen",
  ambulance_stations: "Rettungswachen",
  atms: "Geldautomaten",
  bakeries: "Bäckereien",
  banks: "Banken",
  bars: "Bars",
  beaches: "Strände",
  bicycle_rental: "Fahrradverleih",
  blood_donation: "Blutspende",
  bookstores: "Buchhandlungen",
  cafes: "Cafés",
  camping: "Campingplätze",
  car_rental: "Autovermietungen",
  car_repair: "Autowerkstätten",
  churches: "Kirchen",
  cinemas: "Kinos",
  dentists: "Zahnarztpraxen",
  doctors: "Arztpraxen",
  dog_parks: "Hundeparks",
  drinking_water: "Trinkwasserstellen",
  fire_stations: "Feuerwachen",
  gyms: "Fitnessstudios",
  hairdressers: "Friseursalons",
  hospitals: "Krankenhäuser",
  hotels: "Hotels",
  kindergartens: "Kindergärten",
  laundromats: "Waschsalons",
  libraries: "Bibliotheken",
  markets: "Märkte",
  mosques: "Moscheen",
  museums: "Museen",
  nightlife: "Nachtleben",
  opticians: "Optiker",
  parking: "Parkplätze",
  parks: "Parks",
  pharmacies: "Apotheken",
  police: "Polizei",
  post_offices: "Postämter",
  recycling: "Recyclingstellen",
  restaurants: "Restaurants",
  schools: "Schulen",
  shopping_malls: "Einkaufszentren",
  supermarkets: "Supermärkte",
  swimming: "Schwimmbäder",
  synagogues: "Synagogen",
  temples: "Tempel",
  toilets: "Toiletten",
  transit: "Öffentlicher Verkehr",
  veterinarians: "Tierarztpraxen",
  viewpoints: "Aussichtspunkte",
});

function selectorKey(key: string, value: string): string {
  return `${key}=${value}`;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].filter(Boolean).sort((a, b) => a.localeCompare(b, "en"));
}

function freezeFilter(filter: OverpassFilter): OverpassFilter {
  const normalized = normalizeFilter(filter);
  for (const selector of normalized.selectors) {
    for (const predicate of selector.tags) Object.freeze(predicate);
    Object.freeze(selector.tags);
    Object.freeze(selector);
  }
  Object.freeze(normalized.selectors);
  for (const list of [normalized.require, normalized.exclude]) {
    if (!list) continue;
    for (const predicate of list) Object.freeze(predicate);
    Object.freeze(list);
  }
  if (normalized.elementTypes) Object.freeze(normalized.elementTypes);
  return Object.freeze(normalized);
}

export function buildSemanticCategoryCatalog(): readonly SemanticCategoryDocument[] {
  const executable = CATEGORY_DEFINITIONS.filter(({ id }) => CATEGORY_FILTERS[id]).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const expectedIds = executable.map(({ id }) => id).sort();
  const germanIds = Object.keys(GERMAN_CATEGORY_LABELS).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(germanIds)) {
    throw new Error(
      `German semantic labels do not match executable categories: expected=${expectedIds.join(",")} actual=${germanIds.join(",")}`,
    );
  }

  const ownersBySelector = new Map<string, string[]>();
  for (const definition of executable) {
    for (const { key, value } of CATEGORY_FILTERS[definition.id] ?? []) {
      const selector = selectorKey(key, value);
      const owners = ownersBySelector.get(selector) ?? [];
      if (!owners.includes(definition.id)) owners.push(definition.id);
      ownersBySelector.set(selector, owners);
    }
  }

  const ownerBySelector = new Map<string, string>();
  for (const [selector, owners] of ownersBySelector) {
    owners.sort();
    if (owners.length === 1) {
      ownerBySelector.set(selector, owners[0]);
      continue;
    }
    const explicit = SHARED_SELECTOR_OWNER[selector];
    if (!explicit || !owners.includes(explicit)) {
      throw new Error(`Unresolved semantic selector owner: ${selector} -> ${owners.join(",")}`);
    }
    ownerBySelector.set(selector, explicit);
  }

  const names = new Map<string, Record<SemanticCategoryLanguage, Map<string, string>>>();
  const terms = new Map<string, Record<SemanticCategoryLanguage, Set<string>>>();
  for (const { id } of executable) {
    names.set(id, { en: new Map(), de: new Map() });
    terms.set(id, { en: new Set(), de: new Set() });
  }

  const editor = loadEditorIndex();
  const presets = [...editor.presets.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [presetId, preset] of presets) {
    if (
      !preset.searchable ||
      preset.deprecated ||
      preset.lifecycle ||
      preset.hasWildcardTags ||
      (!preset.geometry.includes("point") && !preset.geometry.includes("area"))
    ) {
      continue;
    }
    const concrete = Object.entries(preset.concreteTags);
    if (concrete.length === 0) continue;
    const owners = concrete.map(([key, value]) => ownerBySelector.get(selectorKey(key, value)));
    if (owners.some((owner) => owner === undefined)) continue;
    const uniqueOwners = new Set(owners as string[]);
    if (uniqueOwners.size !== 1) continue;
    const categoryId = owners[0];
    if (!categoryId) continue;

    for (const lang of ["en", "de"] as const) {
      const text = editor.text.get(lang)?.get(presetId);
      if (!text) continue;
      const normalizedName = normalizeEditorText(text.name);
      if (normalizedName) names.get(categoryId)?.[lang].set(normalizedName, text.name);
      for (const term of text.normalizedTerms) terms.get(categoryId)?.[lang].add(term);
    }
  }

  const documents = executable.map((definition): SemanticCategoryDocument => {
    const filter = categoriesToFilter([definition.id], {});
    if (!filter) throw new Error(`Executable category has no filter: ${definition.id}`);
    const localizedNames = names.get(definition.id);
    const localizedTerms = terms.get(definition.id);
    const englishEvidence = sortedUnique([
      ...(localizedNames?.en.values() ?? []),
      ...(localizedTerms?.en.values() ?? []),
    ]);
    const germanEvidence = sortedUnique([
      ...(localizedNames?.de.values() ?? []),
      ...(localizedTerms?.de.values() ?? []),
    ]);
    const concepts = sortedUnique(
      (CATEGORY_FILTERS[definition.id] ?? [])
        .filter(({ key, value }) => ownerBySelector.get(selectorKey(key, value)) === definition.id)
        .map(({ key, value }) => selectorKey(key, value)),
    );
    const germanLabel = GERMAN_CATEGORY_LABELS[definition.id];
    if (!germanLabel) throw new Error(`Missing German category label: ${definition.id}`);
    const labels = Object.freeze({ en: definition.label, de: germanLabel });
    const document = [
      `Place category: ${definition.label}.`,
      `German label: ${germanLabel}.`,
      `English terms: ${(englishEvidence.length > 0 ? englishEvidence : [definition.label]).join(", ")}.`,
      `German terms: ${(germanEvidence.length > 0 ? germanEvidence : [germanLabel]).join(", ")}.`,
      `OSM concepts: ${(concepts.length > 0 ? concepts : [definition.id]).join(", ")}.`,
    ].join("\n");
    return Object.freeze({
      categoryId: definition.id,
      labels,
      document,
      filter: freezeFilter(filter),
    });
  });

  return Object.freeze(documents);
}
