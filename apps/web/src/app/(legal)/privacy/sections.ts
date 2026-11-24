import { sectionSlug } from "@openmapx/core/legal";
import type { LegalSection } from "@/components/legal/LegalPageShell";

/**
 * Single source of truth for the Privacy Policy's sections. Both the rendered
 * `<Section>` headings (content.*.tsx) and the sidebar nav (page.tsx) derive
 * their titles/anchors from here, so they can never drift out of sync — the
 * anchor slug is computed from the same string on both sides.
 */
type Loc = "en" | "de";

const KEYS = [
  "controller",
  "overview",
  "hosting",
  "geolocation",
  "accounts",
  "reviews",
  "osmContributions",
  "crowdReports",
  "thirdParty",
  "cookies",
  "caching",
  "email",
  "rights",
  "retention",
  "security",
  "children",
  "changes",
] as const;

type SectionKey = (typeof KEYS)[number];

const TITLES: Record<Loc, Record<SectionKey, { title: string; label: string }>> = {
  en: {
    controller: { title: "1. Controller and Contact", label: "Controller and Contact" },
    overview: { title: "2. Overview of Data Processing", label: "Overview" },
    hosting: { title: "3. Hosting and Server Logs", label: "Server Logs" },
    geolocation: { title: "4. Geolocation Data", label: "Geolocation" },
    accounts: { title: "5. User Accounts", label: "User Accounts" },
    reviews: { title: "6. Reviews (Mangrove Open Reviews Standard)", label: "Reviews" },
    osmContributions: {
      title: "7. OpenStreetMap Contributions",
      label: "OSM Contributions",
    },
    crowdReports: { title: "8. Traffic and Hazard Reports", label: "Traffic Reports" },
    thirdParty: {
      title: "9. Third-Party Services and Data Transfers",
      label: "Third-Party Services",
    },
    cookies: { title: "10. Cookies and Local Storage", label: "Cookies and Storage" },
    caching: { title: "11. Server-Side Caching and Databases", label: "Caching and Databases" },
    email: { title: "12. Email Communication", label: "Email" },
    rights: { title: "13. Your Rights Under the GDPR", label: "Your GDPR Rights" },
    retention: { title: "14. Data Retention", label: "Data Retention" },
    security: { title: "15. Security", label: "Security" },
    children: { title: "16. Children's Privacy", label: "Children's Privacy" },
    changes: { title: "17. Changes to This Policy", label: "Changes" },
  },
  de: {
    controller: { title: "1. Verantwortlicher und Kontakt", label: "Verantwortlicher" },
    overview: { title: "2. Übersicht der Datenverarbeitung", label: "Übersicht" },
    hosting: { title: "3. Hosting und Server-Protokolle", label: "Server-Protokolle" },
    geolocation: { title: "4. Standortdaten", label: "Standortdaten" },
    accounts: { title: "5. Benutzerkonten", label: "Benutzerkonten" },
    reviews: { title: "6. Bewertungen (Mangrove Open Reviews Standard)", label: "Bewertungen" },
    osmContributions: {
      title: "7. OpenStreetMap-Beiträge",
      label: "OpenStreetMap-Beiträge",
    },
    crowdReports: { title: "8. Verkehrs- und Gefahrenmeldungen", label: "Verkehrsmeldungen" },
    thirdParty: {
      title: "9. Drittanbieter-Dienste und Datenübermittlungen",
      label: "Drittanbieter-Dienste",
    },
    cookies: { title: "10. Cookies und lokaler Speicher", label: "Cookies und Speicher" },
    caching: {
      title: "11. Serverseitiges Caching und Datenbanken",
      label: "Caching und Datenbanken",
    },
    email: { title: "12. E-Mail-Kommunikation", label: "E-Mail" },
    rights: { title: "13. Ihre Rechte nach der DSGVO", label: "Ihre DSGVO-Rechte" },
    retention: { title: "14. Datenspeicherung", label: "Datenspeicherung" },
    security: { title: "15. Sicherheit", label: "Sicherheit" },
    children: { title: "16. Datenschutz von Kindern", label: "Kinderdatenschutz" },
    changes: { title: "17. Änderungen dieser Erklärung", label: "Änderungen" },
  },
};

/** Section titles for a locale, keyed — for the content to render headings. */
export function privacyTitles(loc: Loc): Record<SectionKey, string> {
  return Object.fromEntries(KEYS.map((k) => [k, TITLES[loc][k].title])) as Record<
    SectionKey,
    string
  >;
}

/** Sidebar nav (id + label) for a locale, in order. */
export function privacyNav(loc: Loc): LegalSection[] {
  return KEYS.map((k) => ({ id: sectionSlug(TITLES[loc][k].title), label: TITLES[loc][k].label }));
}
