import { fetchCapabilities, fetchIntegrations, sectionSlug } from "@openmapx/core/server";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { LegalPageShell, type LegalSection } from "@/components/legal/LegalPageShell";

const sectionsEn: LegalSection[] = [
  { id: sectionSlug("1. Scope and Provider"), label: "Scope and Provider" },
  { id: sectionSlug("2. Description of the Service"), label: "Service Description" },
  { id: sectionSlug("3. Availability and Changes"), label: "Availability" },
  { id: sectionSlug("4. User Accounts"), label: "User Accounts" },
  { id: sectionSlug("5. Acceptable Use"), label: "Acceptable Use" },
  { id: sectionSlug("6. Accuracy and No Warranty"), label: "No Warranty" },
  { id: sectionSlug("7. Limitation of Liability"), label: "Liability" },
  { id: sectionSlug("8. Intellectual Property"), label: "Intellectual Property" },
  { id: sectionSlug("9. Privacy"), label: "Privacy" },
  { id: "data-sources", label: "Data Sources" },
  { id: sectionSlug("11. Third-Party Terms"), label: "Third-Party Terms" },
  { id: sectionSlug("12. Severability"), label: "Severability" },
  { id: sectionSlug("13. Governing Law and Jurisdiction"), label: "Governing Law" },
  { id: sectionSlug("14. Changes to These Terms"), label: "Changes" },
  { id: sectionSlug("15. Language"), label: "Language" },
  { id: sectionSlug("16. Contact"), label: "Contact" },
];

const sectionsDe: LegalSection[] = [
  {
    id: sectionSlug("1. Geltungsbereich und Anbieter"),
    label: "Geltungsbereich",
  },
  {
    id: sectionSlug("2. Beschreibung des Dienstes"),
    label: "Dienstbeschreibung",
  },
  {
    id: sectionSlug("3. Verf\u00fcgbarkeit und \u00c4nderungen"),
    label: "Verf\u00fcgbarkeit",
  },
  { id: sectionSlug("4. Benutzerkonten"), label: "Benutzerkonten" },
  {
    id: sectionSlug("5. Zul\u00e4ssige Nutzung"),
    label: "Zul\u00e4ssige Nutzung",
  },
  {
    id: sectionSlug("6. Genauigkeit und Gew\u00e4hrleistungsausschluss"),
    label: "Gew\u00e4hrleistung",
  },
  {
    id: sectionSlug("7. Haftungsbeschr\u00e4nkung"),
    label: "Haftung",
  },
  {
    id: sectionSlug("8. Geistiges Eigentum"),
    label: "Geistiges Eigentum",
  },
  { id: sectionSlug("9. Datenschutz"), label: "Datenschutz" },
  { id: "data-sources", label: "Datenquellen" },
  {
    id: sectionSlug("11. Drittanbieter-Bedingungen"),
    label: "Drittanbieter",
  },
  {
    id: sectionSlug("12. Salvatorische Klausel"),
    label: "Salvatorische Klausel",
  },
  {
    id: sectionSlug("13. Anwendbares Recht und Gerichtsstand"),
    label: "Anwendbares Recht",
  },
  {
    id: sectionSlug("14. \u00c4nderungen dieser Bedingungen"),
    label: "\u00c4nderungen",
  },
  { id: sectionSlug("15. Sprache"), label: "Sprache" },
  { id: sectionSlug("16. Kontakt"), label: "Kontakt" },
];

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: `${t("termsOfService")} — OpenMapX`,
    description: t("termsDescription"),
  };
}

export default async function TermsPage() {
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
