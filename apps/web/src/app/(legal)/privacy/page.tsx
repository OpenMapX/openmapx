import { fetchCapabilities, fetchIntegrations, sectionSlug } from "@openmapx/core/server";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { LegalPageShell, type LegalSection } from "@/components/legal/LegalPageShell";

const sectionsEn: LegalSection[] = [
  { full: "1. Controller and Contact", label: "Controller and Contact" },
  { full: "2. Overview of Data Processing", label: "Overview" },
  { full: "3. Hosting and Server Logs", label: "Server Logs" },
  { full: "4. Geolocation Data", label: "Geolocation" },
  { full: "5. User Accounts", label: "User Accounts" },
  { full: "6. Third-Party Services and Data Transfers", label: "Third-Party Services" },
  { full: "7. Cookies and Local Storage", label: "Cookies and Storage" },
  { full: "8. Server-Side Caching and Databases", label: "Caching and Databases" },
  { full: "9. Email Communication", label: "Email" },
  { full: "10. Your Rights Under the GDPR", label: "Your GDPR Rights" },
  { full: "11. Data Retention", label: "Data Retention" },
  { full: "12. Security", label: "Security" },
  { full: "13. Children's Privacy", label: "Children's Privacy" },
  { full: "14. Changes to This Policy", label: "Changes" },
].map((s) => ({ id: sectionSlug(s.full), label: s.label }));

const sectionsDe: LegalSection[] = [
  { full: "1. Verantwortlicher und Kontakt", label: "Verantwortlicher" },
  { full: "2. \u00dcbersicht der Datenverarbeitung", label: "\u00dcbersicht" },
  { full: "3. Hosting und Server-Protokolle", label: "Server-Protokolle" },
  { full: "4. Standortdaten", label: "Standortdaten" },
  { full: "5. Benutzerkonten", label: "Benutzerkonten" },
  {
    full: "6. Drittanbieter-Dienste und Daten\u00fcbermittlungen",
    label: "Drittanbieter-Dienste",
  },
  { full: "7. Cookies und lokaler Speicher", label: "Cookies und Speicher" },
  {
    full: "8. Serverseitiges Caching und Datenbanken",
    label: "Caching und Datenbanken",
  },
  { full: "9. E-Mail-Kommunikation", label: "E-Mail" },
  { full: "10. Ihre Rechte nach der DSGVO", label: "Ihre DSGVO-Rechte" },
  { full: "11. Datenspeicherung", label: "Datenspeicherung" },
  { full: "12. Sicherheit", label: "Sicherheit" },
  { full: "13. Datenschutz von Kindern", label: "Kinderdatenschutz" },
  {
    full: "14. \u00c4nderungen dieser Erkl\u00e4rung",
    label: "\u00c4nderungen",
  },
].map((s) => ({ id: sectionSlug(s.full), label: s.label }));

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: `${t("privacyPolicy")} — OpenMapX`,
    description: t("privacyDescription"),
  };
}

export default async function PrivacyPage() {
  const locale = await getLocale();
  const sections = locale === "de" ? sectionsDe : sectionsEn;
  const Content =
    locale === "de"
      ? (await import("./content.de")).default
      : (await import("./content.en")).default;

  const [capabilities, integrations] = await Promise.all([
    fetchCapabilities(),
    fetchIntegrations(),
  ]);

  return (
    <LegalPageShell sections={sections}>
      <Content capabilities={capabilities} integrations={integrations} />
    </LegalPageShell>
  );
}
