import { sectionSlug } from "@openmapx/core/legal";
import type { LegalSection } from "@/components/legal/LegalPageShell";

/**
 * Single source of truth for the Terms of Service sections, mirroring the
 * Privacy Policy's `sections.ts`.
 *
 * Before this existed the sidebar in `page.tsx` carried its own hand-written
 * copy of every numbered title. It had drifted: one section was missing from
 * the nav entirely and the last six entries pointed at anchors that no longer
 * existed, because the content had been renumbered without the nav. Deriving
 * both sides from one list makes that class of drift impossible — and the
 * colocated test pins the ordering, numbering and anchor uniqueness.
 */
type Loc = "en" | "de";

const KEYS = [
  "scope",
  "service",
  "availability",
  "accounts",
  "acceptableUse",
  "warranty",
  "aiSearch",
  "liability",
  "intellectualProperty",
  "privacy",
  "reviews",
  "osmContributions",
  "dataSources",
  "thirdParty",
  "severability",
  "governingLaw",
  "changes",
  "language",
  "contact",
] as const;

export type TermsSectionKey = (typeof KEYS)[number];

interface Entry {
  /** The rendered heading, including its number where the section has one. */
  title: string;
  /** Short sidebar label. */
  label: string;
  /**
   * Explicit anchor, for the two sections whose anchor must stay stable
   * independently of their (renumbered) heading.
   */
  id?: string;
}

const SECTIONS: Record<Loc, Record<TermsSectionKey, Entry>> = {
  en: {
    scope: { title: "1. Scope and Provider", label: "Scope and Provider" },
    service: { title: "2. Description of the Service", label: "Service Description" },
    availability: { title: "3. Availability and Changes", label: "Availability" },
    accounts: { title: "4. User Accounts", label: "User Accounts" },
    acceptableUse: { title: "5. Acceptable Use", label: "Acceptable Use" },
    warranty: { title: "6. Accuracy and No Warranty", label: "No Warranty" },
    aiSearch: { title: "AI-Assisted Search", label: "AI-Assisted Search", id: "ai-search" },
    liability: { title: "7. Limitation of Liability", label: "Liability" },
    intellectualProperty: { title: "8. Intellectual Property", label: "Intellectual Property" },
    privacy: { title: "9. Privacy", label: "Privacy" },
    reviews: { title: "10. User-Generated Content (Reviews)", label: "Reviews" },
    osmContributions: {
      title: "11. OpenStreetMap Contributions",
      label: "OSM Contributions",
    },
    dataSources: {
      title: "12. Data Sources and Attribution",
      label: "Data Sources",
      id: "data-sources",
    },
    thirdParty: { title: "13. Third-Party Terms", label: "Third-Party Terms" },
    severability: { title: "14. Severability", label: "Severability" },
    governingLaw: { title: "15. Governing Law and Jurisdiction", label: "Governing Law" },
    changes: { title: "16. Changes to These Terms", label: "Changes" },
    language: { title: "17. Language", label: "Language" },
    contact: { title: "18. Contact", label: "Contact" },
  },
  de: {
    scope: { title: "1. Geltungsbereich und Anbieter", label: "Geltungsbereich" },
    service: { title: "2. Beschreibung des Dienstes", label: "Dienstbeschreibung" },
    availability: { title: "3. Verfügbarkeit und Änderungen", label: "Verfügbarkeit" },
    accounts: { title: "4. Benutzerkonten", label: "Benutzerkonten" },
    acceptableUse: { title: "5. Zulässige Nutzung", label: "Zulässige Nutzung" },
    warranty: {
      title: "6. Genauigkeit und Gewährleistungsausschluss",
      label: "Gewährleistung",
    },
    aiSearch: { title: "KI-gestützte Suche", label: "KI-gestützte Suche", id: "ai-search" },
    liability: { title: "7. Haftungsbeschränkung", label: "Haftung" },
    intellectualProperty: { title: "8. Geistiges Eigentum", label: "Geistiges Eigentum" },
    privacy: { title: "9. Datenschutz", label: "Datenschutz" },
    reviews: { title: "10. Nutzergenerierte Inhalte (Bewertungen)", label: "Bewertungen" },
    osmContributions: {
      title: "11. OpenStreetMap-Beiträge",
      label: "OpenStreetMap-Beiträge",
    },
    dataSources: {
      title: "12. Datenquellen und Quellenangaben",
      label: "Datenquellen",
      id: "data-sources",
    },
    thirdParty: { title: "13. Drittanbieter-Bedingungen", label: "Drittanbieter" },
    severability: { title: "14. Salvatorische Klausel", label: "Salvatorische Klausel" },
    governingLaw: { title: "15. Anwendbares Recht und Gerichtsstand", label: "Anwendbares Recht" },
    changes: { title: "16. Änderungen dieser Bedingungen", label: "Änderungen" },
    language: { title: "17. Sprache", label: "Sprache" },
    contact: { title: "18. Kontakt", label: "Kontakt" },
  },
};

/** The anchor a section renders, matching what the sidebar links to. */
export function termsSectionId(loc: Loc, key: TermsSectionKey): string {
  const entry = SECTIONS[loc][key];
  return entry.id ?? sectionSlug(entry.title);
}

/** Section titles for a locale, keyed — for the content to render headings. */
export function termsTitles(loc: Loc): Record<TermsSectionKey, string> {
  return Object.fromEntries(KEYS.map((k) => [k, SECTIONS[loc][k].title])) as Record<
    TermsSectionKey,
    string
  >;
}

/** Explicit anchor overrides for a locale, keyed. Undefined means "derive it". */
export function termsIds(loc: Loc): Record<TermsSectionKey, string | undefined> {
  return Object.fromEntries(KEYS.map((k) => [k, SECTIONS[loc][k].id])) as Record<
    TermsSectionKey,
    string | undefined
  >;
}

/** Sidebar nav (id + label) for a locale, in order. */
export function termsNav(loc: Loc): LegalSection[] {
  return KEYS.map((k) => ({ id: termsSectionId(loc, k), label: SECTIONS[loc][k].label }));
}

export const TERMS_SECTION_KEYS = KEYS;
