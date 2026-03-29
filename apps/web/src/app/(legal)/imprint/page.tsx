import { sectionSlug } from "@openmapx/core/server";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { LegalPageShell, type LegalSection } from "@/components/legal/LegalPageShell";

const sectionsEn: LegalSection[] = [
  "Provider",
  "Contact",
  "Responsible for Content",
  "Consumer Dispute Resolution",
  "Liability for Content",
  "Liability for Links",
  "Copyright",
  "Map Data and Third-Party Attributions",
].map((t) => ({ id: sectionSlug(t), label: t }));

const sectionsDe: LegalSection[] = [
  "Anbieter",
  "Kontakt",
  "Verantwortlich f\u00fcr den Inhalt",
  "Verbraucherstreitbeilegung",
  "Haftung f\u00fcr Inhalte",
  "Haftung f\u00fcr Links",
  "Urheberrecht",
  "Kartendaten und Drittanbieter-Zuordnungen",
].map((t) => ({ id: sectionSlug(t), label: t }));

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: `${t("imprint")} — OpenMapX`,
    description: t("imprintDescription"),
  };
}

export default async function ImprintPage() {
  const locale = await getLocale();
  const sections = locale === "de" ? sectionsDe : sectionsEn;
  const Content =
    locale === "de"
      ? (await import("./content.de")).default
      : (await import("./content.en")).default;

  return (
    <LegalPageShell sections={sections}>
      <Content />
    </LegalPageShell>
  );
}
