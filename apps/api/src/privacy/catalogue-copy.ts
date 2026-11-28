import { createTranslator, type Locale, locales, resolveLocale } from "@openmapx/i18n";
import {
  extensionRegistrationText,
  SUBJECT_DATA_CATALOGUE,
  SUBJECT_DATA_CATALOGUE_BY_ID,
  subjectDataCatalogue,
} from "./catalogue";

export type CatalogueLocale = Locale;

export interface CatalogueCopyEntry {
  category: string;
  purpose: string;
  source: string;
  retention: string;
  safeRepresentation: string;
  portabilityExclusion: string;
  rightsOfOthers: string;
}

const fields = [
  "category",
  "purpose",
  "source",
  "retention",
  "safeRepresentation",
  "portabilityExclusion",
  "rightsOfOthers",
] as const;

function makeEntry(id: string, locale: Locale): CatalogueCopyEntry {
  const t = createTranslator(locale, "privacyExport.catalogue");
  return Object.fromEntries(
    fields.map((field) => {
      const key = `entries.${id}.${field}`;
      return [
        field,
        t.has(key)
          ? t(key)
          : field === "category"
            ? (SUBJECT_DATA_CATALOGUE.find((entry) => entry.id === id)?.category ?? id)
            : t(`defaults.${field}`),
      ];
    }),
  ) as unknown as CatalogueCopyEntry;
}

export const catalogueCopy = Object.fromEntries(
  locales.map((locale) => [
    locale,
    Object.fromEntries(SUBJECT_DATA_CATALOGUE.map(({ id }) => [id, makeEntry(id, locale)])),
  ]),
) as Record<Locale, Record<string, CatalogueCopyEntry>>;

export function getCatalogueCopy(locale: string, id: string): CatalogueCopyEntry {
  return getCatalogueCopyWithFallbacks(locale, id).copy;
}

/**
 * The copy of registration `id` in `locale`. An extension's registration
 * takes its category from the title and its purpose from the description
 * the extension declared, in the extension's words; the other fields, and
 * a missing title or description, use the catalogue's defaults.
 */
export function getCatalogueCopyWithFallbacks(locale: string, id: string) {
  const resolved = resolveLocale(locale);
  const t = createTranslator(resolved, "privacyExport.catalogue");
  const declared = SUBJECT_DATA_CATALOGUE_BY_ID.has(id) ? undefined : extensionRegistrationText(id);
  const registration = subjectDataCatalogue().find((entry) => entry.id === id);
  const copy = Object.fromEntries(
    fields.map((field) => {
      const key = `entries.${id}.${field}`;
      if (field === "category" && declared?.title) return [field, declared.title];
      if (field === "purpose" && declared?.description) return [field, declared.description];
      return [
        field,
        !declared && t.has(key)
          ? t(key)
          : field === "category"
            ? (registration?.category ?? id)
            : t(`defaults.${field}`),
      ];
    }),
  ) as unknown as CatalogueCopyEntry;
  return { copy, translationFallbacks: t.fallbacks() };
}
